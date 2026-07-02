import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

import type { Logger } from "../adapters/types.js";
import {
  JSONRPC_VERSION,
  ShannonError,
  parseNdjson,
  serializeFrame,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ShannonEvent,
  type ShannonEventNotification,
} from "./protocol.js";

/**
 * The inbound mobile server — a WebSocket endpoint speaking NDJSON `shannon/*`
 * JSON-RPC. Unlike the 8 platform `ChannelAdapter`s (outbound chat clients with
 * a reply-target model), this is a *server* the phone dials, and the phone is a
 * first-class streaming client: it receives the full engine event stream as
 * `shannon/event` notifications (architecture doc §5.2, Option B).
 *
 * The server owns only transport + per-connection dispatch. Every method's
 * behavior is injected via `MethodHandlers` so:
 *  - P1.1a ships routing + handshake with mock handlers,
 *  - P1.1b wires the real engine bridge (query/cancel/approval/health/model),
 *  - tests inject fakes — no real socket or engine needed for unit coverage.
 *
 * Auth is an optional `authenticator` hook; P1.1 leaves it unset and P1.2
 * injects Ed25519 verification (every approval decision is signed).
 */

export interface MethodContext {
  /** The underlying socket (handlers may close it, e.g. on auth failure). */
  readonly socket: WebSocket;
  /**
   * Device session id once paired. `null` in P1.1 (no pairing yet); P1.2 sets
   * it after `shannon/pair` so subsequent methods bind to the device session.
   */
  sessionId: string | null;
  readonly logger: Logger;
}

/** Discriminated handler outcome — unambiguous vs. duck-typing the result. */
export type HandlerOutcome =
  | { kind: "result"; result: unknown }
  | { kind: "stream"; stream: AsyncIterable<ShannonEvent>; result: unknown }
  | { kind: "error"; code: number; message: string; data?: unknown };

export type MethodHandler = (params: unknown, ctx: MethodContext) => Promise<HandlerOutcome> | HandlerOutcome;

export interface MethodHandlers {
  [method: string]: MethodHandler;
}

export interface AuthenticatorContext {
  socket: WebSocket;
  req: IncomingMessage;
}

export interface MobileServerOptions {
  host: string;
  port: number;
  logger: Logger;
  handlers: MethodHandlers;
  /** WS path (default "/"). */
  path?: string;
  /**
   * Optional connection gate. P1.1 leaves this unset (open for testing); P1.2
   * injects Ed25519 device verification. Returning `false` closes the socket
   * with code 4001 and dispatches no methods.
   */
  authenticator?: (ctx: AuthenticatorContext) => boolean | Promise<boolean>;
}

export interface MobileServerHandle {
  /** The bound port (useful when `port: 0` was requested for a free port). */
  readonly port: number;
  stop(): Promise<void>;
}

export class MobileServer {
  private wss: WebSocketServer | null = null;
  private readonly opts: MobileServerOptions;

  constructor(opts: MobileServerOptions) {
    this.opts = opts;
  }

  /** Bind and wait for the listener. */
  async start(): Promise<MobileServerHandle> {
    const wss = new WebSocketServer({
      host: this.opts.host,
      port: this.opts.port,
      path: this.opts.path ?? "/",
    });
    this.wss = wss;
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const boundPort =
      this.opts.port === 0 ? (wss.address() as { port: number }).port : this.opts.port;

    wss.on("connection", (socket, req) => {
      void this.onConnection(socket, req);
    });

    this.opts.logger.info(
      `mobile server listening on ${this.opts.host}:${boundPort}${this.opts.path ?? "/"}`,
    );
    return {
      get port() {
        return boundPort;
      },
      stop: () => this.stop(),
    };
  }

  async stop(): Promise<void> {
    const wss = this.wss;
    if (!wss) return;
    this.wss = null;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  // ── connection lifecycle ──────────────────────────────────────────────

  private async onConnection(socket: WebSocket, req: IncomingMessage): Promise<void> {
    if (this.opts.authenticator) {
      let ok = false;
      try {
        ok = await this.opts.authenticator({ socket, req });
      } catch {
        ok = false;
      }
      if (!ok) {
        socket.close(4001, "unauthorized");
        return;
      }
    }
    const ctx: MethodContext = { socket, sessionId: null, logger: this.opts.logger };

    socket.on("message", (data) => {
      const text = frameToString(data);
      void this.onMessage(text, ctx);
    });
    socket.on("error", (err) =>
      this.opts.logger.warn(`mobile socket error: ${(err as Error).message}`),
    );
  }

  private async onMessage(text: string, ctx: MethodContext): Promise<void> {
    for (const record of parseNdjson(text)) {
      if (record === null) {
        this.send(ctx, errorResponse(null, ShannonError.PARSE_ERROR, "malformed JSON"));
        continue;
      }
      await this.dispatch(record, ctx);
    }
  }

  private async dispatch(raw: unknown, ctx: MethodContext): Promise<void> {
    if (!isRequest(raw)) {
      this.send(
        ctx,
        errorResponse(null, ShannonError.INVALID_REQUEST, "not a valid JSON-RPC request"),
      );
      return;
    }
    const handler = this.opts.handlers[raw.method];
    if (!handler) {
      this.send(
        ctx,
        errorResponse(raw.id, ShannonError.METHOD_NOT_FOUND, `no handler for ${raw.method}`),
      );
      return;
    }
    try {
      const outcome = await handler(raw.params, ctx);
      if (outcome.kind === "error") {
        this.send(
          ctx,
          errorResponse(raw.id, outcome.code, outcome.message, outcome.data),
        );
        return;
      }
      if (outcome.kind === "stream") {
        for await (const ev of outcome.stream) {
          if (ctx.socket.readyState !== WebSocket.OPEN) return;
          this.send(ctx, notification(ev));
        }
      }
      this.send(ctx, successResponse(raw.id, outcome.result));
    } catch (err) {
      const message = (err as Error).message ?? "handler error";
      this.send(ctx, errorResponse(raw.id, ShannonError.ENGINE_ERROR, message));
    }
  }

  private send(ctx: MethodContext, value: unknown): void {
    if (ctx.socket.readyState !== WebSocket.OPEN) return;
    ctx.socket.send(serializeFrame(value));
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function frameToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data as Uint8Array);
  return String(data);
}

function isRequest(v: unknown): v is JsonRpcRequest {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r.jsonrpc === JSONRPC_VERSION &&
    typeof r.method === "string" &&
    (typeof r.id === "string" || typeof r.id === "number")
  );
}

function successResponse(id: string | number, result: unknown): JsonRpcResponse<unknown> {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse<unknown> {
  const error: { code: number; message: string; data?: unknown } = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id, error };
}

function notification(event: ShannonEvent): ShannonEventNotification {
  return { jsonrpc: JSONRPC_VERSION, method: "shannon/event", params: event };
}
