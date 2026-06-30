import { type RawData, WebSocket } from "ws";

import { PushQueue, type CloseReason } from "../lib/pushQueue.js";
import {
  type EngineEvent,
  type EngineEventType,
  type QueryRequest,
  isTerminalEvent,
} from "./types.js";

/**
 * Typed WebSocket client for the Shannon engine's `/api/ws`.
 *
 * One socket, one query at a time. The engine processes turns sequentially on
 * a connection, and the gateway's session router (P1-c) gives each session its
 * own client — so per-socket serialization maps cleanly onto per-session
 * serialization. Mid-stream `cancel()` and out-of-band `approval_request`
 * frames are delivered through the same event stream.
 *
 * Lifecycle: `connect()` → `runQuery()` (zero or more, sequential) → `close()`.
 *
 * Uses the `ws` Node EventEmitter API (`.on`), not the browser `addEventListener`
 * shape — the error callback receives an `Error`, not an `ErrorEvent`.
 */

export interface EngineWsClientOptions {
  /** Full WebSocket URL, e.g. `ws://127.0.0.1:33420/api/ws`. */
  url: string;
  /** Default model for queries that don't override it. */
  model?: string | null;
  /** Default session id (UUID string) for conversation continuity. */
  sessionId?: string | null;
}

const KNOWN_EVENT_TYPES: ReadonlySet<EngineEventType> = new Set([
  "text",
  "tool_use",
  "tool_result",
  "usage",
  "completed",
  "failed",
  "cancelled",
  "approval_request",
  "session_info",
  "error",
]);

/**
 * Parse one wire frame. Returns `null` for anything that isn't a recognized
 * engine event. The engine is the only sender and its types are fixed, so a
 * shallow `type` check is sufficient; add a hardening layer only if an
 * untrusted sender ever shares the socket.
 */
function parseEngineEvent(raw: unknown): EngineEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const type = (raw as { type?: unknown }).type;
  if (
    typeof type !== "string" ||
    !KNOWN_EVENT_TYPES.has(type as EngineEventType)
  ) {
    return null;
  }
  return raw as EngineEvent;
}

/** Decode a `ws` RawData payload to parsed JSON. Returns null if unrecognized. */
function parseFrame(data: RawData): unknown {
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else if (Buffer.isBuffer(data)) {
    text = data.toString("utf8");
  } else if (data instanceof ArrayBuffer) {
    text = new TextDecoder().decode(data);
  } else if (Array.isArray(data)) {
    // Buffer[] — fragmented assembly.
    text = Buffer.concat(data).toString("utf8");
  } else if (ArrayBuffer.isView(data)) {
    text = new TextDecoder().decode(data as Uint8Array);
  } else {
    return null;
  }
  return JSON.parse(text);
}

export class EngineWsClient {
  private socket: WebSocket | null = null;
  private activeQueue: PushQueue<EngineEvent> | null = null;
  private readonly url: string;
  private readonly defaultModel: string | null;
  private readonly defaultSessionId: string | null;

  constructor(options: EngineWsClientOptions) {
    this.url = options.url;
    this.defaultModel = options.model ?? null;
    this.defaultSessionId = options.sessionId ?? null;
  }

  get isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /** Open the socket and wait for it to be ready. Idempotent. */
  async connect(): Promise<void> {
    if (this.socket) return;
    const socket = new WebSocket(this.url);
    await waitForOpen(socket);
    socket.on("message", (data) => this.onMessage(data));
    socket.on("close", () => this.onSocketClosed());
    socket.on("error", (err) => this.onSocketError(err));
    this.socket = socket;
  }

  /**
   * Send a query and yield the resulting event stream until a terminal frame
   * (completed / failed / cancelled / error). Throws if the socket isn't open
   * or another query is already in flight on this client.
   */
  async *runQuery(
    prompt: string,
    opts: { model?: string | null; sessionId?: string | null } = {},
  ): AsyncGenerator<EngineEvent> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("EngineWsClient not connected; call connect() first");
    }
    if (this.activeQueue) {
      throw new Error("a query is already in flight on this client");
    }

    const req: QueryRequest = {
      type: "query",
      prompt,
      model: opts.model ?? this.defaultModel,
      session_id: opts.sessionId ?? this.defaultSessionId,
    };

    const queue = new PushQueue<EngineEvent>();
    this.activeQueue = queue;
    socket.send(JSON.stringify(req));

    try {
      for await (const ev of queue) {
        yield ev;
        if (isTerminalEvent(ev)) break;
      }
    } finally {
      this.activeQueue = null;
    }
  }

  /** Interrupt the in-progress query. No-op if the socket isn't open. */
  cancel(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "cancel" }));
  }

  /** Close the socket. Resolves once the underlying socket has closed. */
  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    // End any in-flight consumer cleanly so its `for await` stops.
    this.activeQueue?.close({ kind: "done" } satisfies CloseReason);
    this.activeQueue = null;
    await closeSocket(socket);
    this.socket = null;
  }

  // ── frame routing ──────────────────────────────────────────────────

  private onMessage(data: RawData): void {
    const parsed = parseEngineEvent(parseFrame(data));
    if (!parsed) return; // unknown / malformed — ignore for now
    const queue = this.activeQueue;
    if (!queue) return; // no active consumer (e.g. unsolicited session_info)
    queue.push(parsed);
    if (isTerminalEvent(parsed)) {
      queue.close({ kind: "done" } satisfies CloseReason);
    }
  }

  private onSocketError(err: Error): void {
    this.activeQueue?.close({
      kind: "error",
      error: new Error(`engine socket error: ${err.message}`),
    } satisfies CloseReason);
  }

  private onSocketClosed(): void {
    // An unexpected close mid-stream surfaces as an error so a truncated turn
    // isn't silently swallowed. After a normal terminal frame the queue is
    // already cleared, so this is a no-op.
    this.activeQueue?.close({
      kind: "error",
      error: new Error("engine socket closed before terminal event"),
    } satisfies CloseReason);
    this.socket = null;
  }
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      socket.off("open", onOpen);
      socket.off("error", onError);
      resolve();
    };
    const onError = (err: Error): void => {
      socket.off("open", onOpen);
      socket.off("error", onError);
      reject(err);
    };
    socket.on("open", onOpen);
    socket.on("error", onError);
  });
}

function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onClose = (): void => {
      socket.off("close", onClose);
      resolve();
    };
    socket.on("close", onClose);
    socket.close();
  });
}
