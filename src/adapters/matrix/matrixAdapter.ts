import {
  type AdapterContext,
  type ApprovalDecision,
  type ApprovalReq,
  type ChannelAdapter,
  type MessageReceipt,
  type NormalizedInbound,
  type ReplyTarget,
  type SendOpts,
} from "../types.js";
import { type AdapterConfig } from "../../config/types.js";

/**
 * Matrix adapter (Client-Server API v3).
 *
 * Inbound: long-poll `GET /_matrix/client/v3/sync` — iterate the joined
 * rooms' timelines for `m.room.message` text events (Matrix has no push
 * webhook equivalent as simple as this for a bot). `since` pagination keeps
 * each poll returning only new events. The bot's own echoes are skipped via
 * `whoami` user id.
 *
 * Outbound: `PUT .../rooms/{roomId}/send/m.room.message/{txnId}` — the txnId
 * gives idempotency. Auth via `Authorization: Bearer <token>`.
 *
 * Sessions: a Matrix room is the session unit (`threading = false`);
 * `target.threadId` carries the inbound `event_id` so replies use
 * `m.in_reply_to` (F4 UX). Matrix *does* have thread relations — enabling
 * per-thread sessions is a later refinement.
 *
 * Approval: **Matrix has no native buttons**, so `approvalButtons = false`.
 * The prompt is posted as text and the adapter intercepts the next
 * `allow`/`deny` reply in the same room (per-session turns are serial, F5, so
 * at most one approval is pending per room). Engine 300s timeout → Deny.
 *
 * Docs: https://spec.matrix.org/v1.10/client-server-api/
 */

// ── raw platform shapes (subset we care about) ─────────────────────────

interface MxMessageContent {
  msgtype?: string;
  body?: string;
  formatted_body?: string;
  "m.relates_to"?: { rel_type?: string; event_id?: string };
}
interface MxEvent {
  type?: string;
  content?: MxMessageContent;
  sender?: string;
  event_id?: string;
  origin_server_ts?: number;
}
interface MxTimeline {
  events?: MxEvent[];
}
interface MxJoinedRoom {
  timeline?: MxTimeline;
}
interface MxSyncResponse {
  next_batch?: string;
  rooms?: { join?: Record<string, MxJoinedRoom> };
}

// ── pure transforms (unit-tested) ───────────────────────────────────────

/** Pull inbound text messages out of a /sync response, skipping own echoes. */
export function extractMessagesFromSync(
  sync: unknown,
  ownUserId: string | null,
): { messages: NormalizedInbound[]; nextBatch: string | undefined } {
  const out: NormalizedInbound[] = [];
  if (typeof sync !== "object" || sync === null) {
    return { messages: out, nextBatch: undefined };
  }
  const resp = sync as MxSyncResponse;
  const joined = resp.rooms?.join ?? {};
  for (const [roomId, room] of Object.entries(joined)) {
    const events = room.timeline?.events ?? [];
    for (const ev of events) {
      const n = normalizeMatrixEvent(ev, roomId, ownUserId);
      if (n) out.push(n);
    }
  }
  return { messages: out, nextBatch: resp.next_batch };
}

/** A Matrix `m.room.message` text event → NormalizedInbound, or null. */
export function normalizeMatrixEvent(
  ev: MxEvent,
  roomId: string,
  ownUserId: string | null,
): NormalizedInbound | null {
  if (ev.type !== "m.room.message") return null;
  if (ownUserId && ev.sender === ownUserId) return null;
  const content = ev.content;
  if (!content || content.msgtype !== "m.text" || typeof content.body !== "string") return null;
  if (content.body.length === 0) return null;
  if (!ev.sender || !ev.event_id) return null;
  return {
    platform: "matrix",
    chatId: roomId,
    senderId: ev.sender,
    senderName: ev.sender,
    text: content.body,
    timestamp: typeof ev.origin_server_ts === "number" ? ev.origin_server_ts : Date.now(),
    threadId: ev.event_id,
    isDirect: false, // DM detection needs account-data lookup; deferred
    raw: ev,
  };
}

export interface MxContent {
  msgtype: "m.text";
  body: string;
  "m.relates_to"?: { "m.in_reply_to": { event_id: string } };
}

/** Build the `m.room.message` content body. Pure. */
export function buildMessageContent(body: string, replyToEventId?: string): MxContent {
  if (replyToEventId) {
    return {
      msgtype: "m.text",
      body,
      "m.relates_to": { "m.in_reply_to": { event_id: replyToEventId } },
    };
  }
  return { msgtype: "m.text", body };
}

export interface MxRequest {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  body: string;
}

/** Build the send-event PUT request. Pure — network call lives in `send`. */
export function buildSendEventRequest(args: {
  baseUrl: string;
  accessToken: string;
  roomId: string;
  txnId: string;
  content: MxContent;
}): MxRequest {
  const url =
    `${args.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(args.roomId)}` +
    `/send/m.room.message/${encodeURIComponent(args.txnId)}`;
  return {
    url,
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.accessToken}`,
    },
    body: JSON.stringify(args.content),
  };
}

/** Human-readable approval prompt (plain text — Matrix has no buttons). */
export function formatApprovalPrompt(req: ApprovalReq): string {
  const tag = req.isDestructive ? "⚠️ DESTRUCTIVE" : "tool";
  const diff = req.diffPreview ? `\n\n${req.diffPreview}` : "";
  return `🔐 Approval (${tag}): ${req.toolName}\n${req.description}${diff}\n— reply "allow" or "deny"`;
}

/** Recognize a free-text allow/deny reply. Case-insensitive, trims. */
export function parseChoice(text: string): "allow" | "deny" | null {
  const t = text.trim().toLowerCase();
  if (t === "allow" || t === "yes" || t === "y" || t === "✅" || t === "approve") return "allow";
  if (t === "deny" || t === "no" || t === "n" || t === "❌" || t === "reject") return "deny";
  return null;
}

// ── adapter ────────────────────────────────────────────────────────────

export interface MatrixAdapterOptions {
  /** Keyring key for the access token. Default `matrix/access-token`. */
  accessTokenKey?: string;
  /** Homeserver Client-Server base, e.g. `https://matrix.org`. */
  baseUrl: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Sync long-poll timeout (ms). Default 30000. */
  syncTimeoutMs?: number;
  /** Poll retry delay after an error (ms). Default 5000. */
  errorDelayMs?: number;
}

interface PendingApproval {
  requestId: string;
  roomId: string;
  resolve: (choice: "allow" | "deny") => void;
}

export function createMatrixAdapter(
  cfg: AdapterConfig,
  ctx: AdapterContext,
): ChannelAdapter {
  const o = (cfg.options ?? {}) as unknown as MatrixAdapterOptions;
  const tokenKey = o.accessTokenKey ?? "matrix/access-token";
  const baseUrlRaw = typeof o.baseUrl === "string" ? o.baseUrl : "";
  if (baseUrlRaw.length === 0) {
    throw new Error("matrix: options.baseUrl is required (homeserver Client-Server base)");
  }
  const baseUrl = baseUrlRaw.replace(/\/+$/, "");
  const fetchImpl = o.fetchImpl ?? fetch;
  const syncTimeout = o.syncTimeoutMs ?? 30_000;
  const errorDelay = o.errorDelayMs ?? 5_000;

  let token: string | null = null;
  let ownUserId: string | null = null;
  let onMessage: ((m: NormalizedInbound) => void) | null = null;
  let since: string | undefined;
  let running = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let txnCounter = 0;
  const pending = new Map<string, PendingApproval>(); // keyed by roomId

  async function whoami(): Promise<string> {
    const res = await fetchImpl(`${baseUrl}/_matrix/client/v3/account/whoami`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`matrix whoami failed: HTTP ${res.status}`);
    const data = (await res.json()) as { user_id?: string };
    if (typeof data.user_id !== "string") throw new Error("matrix whoami returned no user_id");
    return data.user_id;
  }

  async function syncPoll(): Promise<void> {
    if (!running || !token) return;
    try {
      const url =
        `${baseUrl}/_matrix/client/v3/sync?timeout=${syncTimeout}` +
        (since ? `&since=${encodeURIComponent(since)}` : "");
      const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const { messages, nextBatch } = extractMessagesFromSync(data, ownUserId);
      if (nextBatch) since = nextBatch;
      for (const m of messages) routeInbound(m);
    } catch (err) {
      ctx.logger.warn(`matrix sync failed: ${(err as Error).message}`);
    }
    if (running) pollTimer = setTimeout(() => void syncPoll(), errorDelay);
  }

  /** Forward to the router, unless this room has a pending approval and the
   * message is an allow/deny reply — in which case resolve it and swallow. */
  function routeInbound(m: NormalizedInbound): void {
    const p = pending.get(m.chatId);
    if (p) {
      const choice = parseChoice(m.text);
      if (choice) {
        pending.delete(m.chatId);
        p.resolve(choice);
        return;
      }
    }
    onMessage?.(m);
  }

  async function doSend(target: ReplyTarget, text: string): Promise<MessageReceipt> {
    if (!token) throw new Error("matrix: start() not called or token missing");
    txnCounter += 1;
    const txnId = `shannon-${Date.now()}-${txnCounter}`;
    const content = buildMessageContent(text, target.threadId);
    const req = buildSendEventRequest({
      baseUrl,
      accessToken: token,
      roomId: target.chatId,
      txnId,
      content,
    });
    const res = await fetchImpl(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`matrix send failed: HTTP ${res.status} ${detail}`);
    }
    const data = (await res.json()) as { event_id?: string };
    return { messageId: data.event_id ?? txnId };
  }

  return {
    platform: "matrix",
    capabilities: {
      threading: false,
      pairing: false,
      approvalButtons: false, // Matrix has no native buttons → text-reply flow
      streaming: "partial",
    },
    async start(): Promise<void> {
      token = await ctx.getSecret(tokenKey);
      if (!token) throw new Error(`matrix: secret "${tokenKey}" missing from keyring`);
      ownUserId = await whoami();
      running = true;
      void syncPoll();
    },
    async stop(): Promise<void> {
      running = false;
      if (pollTimer) clearTimeout(pollTimer);
    },
    onMessage(handler): void {
      onMessage = handler;
    },
    async send(target, text, _opts?: SendOpts): Promise<MessageReceipt> {
      return await doSend(target, text);
    },
    async requestApproval(target, req): Promise<ApprovalDecision> {
      await doSend(target, formatApprovalPrompt(req));
      return await new Promise<ApprovalDecision>((resolve) => {
        pending.set(target.chatId, {
          requestId: req.requestId,
          roomId: target.chatId,
          resolve: (choice) => resolve({ requestId: req.requestId, choice }),
        });
        // Engine 300s approval timeout resolves to Deny if no reply arrives.
      });
    },
    resolveSessionConversation(rawId): { baseChatId: string } {
      return { baseChatId: rawId };
    },
  };
}
