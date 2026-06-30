import { type RawData, WebSocket } from "ws";

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
 * Discord adapter (Bot API v10 + Gateway WebSocket).
 *
 * Inbound: the Discord **Gateway** WebSocket — connect, IDENTIFY with the
 * MESSAGE_CONTENT / GUILD_MESSAGES / DIRECT_MESSAGES intents, then consume
 * `MESSAGE_CREATE` dispatches. This is the canonical Discord inbound path
 * (there is no long-poll equivalent of Telegram's `getUpdates`). The Gateway
 * protocol is wired in `start()`; the per-event transform is pure and tested.
 *
 * Outbound: `POST /channels/{channel.id}/messages` with
 * `Authorization: Bot <token>`.
 *
 * Sessions: a Discord text channel is the session unit (`threading = false`);
 * `target.threadId` carries the inbound `message_id` so replies quote it via
 * `message_reference` (F4 UX continuity). Discord *does* have native threads,
 * but enabling per-thread sessions is a later refinement.
 *
 * Approval: posts the request with an Allow/Deny **button row** (component
 * type 2). A click arrives as an `INTERACTION_CREATE`; the adapter acks it
 * (UPDATE_MESSAGE, removing the buttons) and resolves the pending promise.
 * With no live bot the engine's 300s approval timeout resolves to Deny.
 *
 * Docs: https://discord.com/developers/docs
 */

// ── raw platform shapes (subset we care about) ─────────────────────────

interface DcUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}
export interface DcMessage {
  id: string;
  channel_id: string;
  content?: string;
  author?: DcUser;
  guild_id?: string | null;
  timestamp?: string;
  /** Present when the message is inside a thread channel. */
  thread?: { id: string };
}
interface DcInteractionData {
  component_type?: number;
  custom_id?: string;
}
interface DcInteraction {
  id: string;
  token: string;
  type: number; // 3 = MESSAGE_COMPONENT
  data?: DcInteractionData;
  channel_id?: string;
  message?: { id: string };
}

// ── pure transforms (unit-tested) ───────────────────────────────────────

/** A Discord `MESSAGE_CREATE` message → NormalizedInbound, or null (bots/no text). */
export function normalizeDiscordMessage(message: unknown): NormalizedInbound | null {
  if (typeof message !== "object" || message === null) return null;
  const m = message as DcMessage;
  if (typeof m.id !== "string" || typeof m.channel_id !== "string") return null;
  if (typeof m.content !== "string" || m.content.length === 0) return null;
  const author = m.author;
  if (!author || author.bot) return null;
  return {
    platform: "discord",
    chatId: m.channel_id,
    senderId: author.id,
    senderName: author.global_name ?? author.username,
    text: m.content,
    timestamp: parseDiscordTimestamp(m.timestamp),
    threadId: m.id,
    isDirect: !m.guild_id,
    raw: message,
  };
}

function parseDiscordTimestamp(iso: string | undefined): number {
  if (typeof iso !== "string") return Date.now();
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Date.now() : t;
}

export interface CreateMessageArgs {
  token: string;
  apiBaseUrl: string;
  target: ReplyTarget;
  content: string;
  /** Discord component tree (e.g. approval button row). */
  components?: unknown[];
}

export interface DcRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/** Build a create-message request. Pure — network call lives in `send`. */
export function buildCreateMessageRequest(args: CreateMessageArgs): DcRequest {
  const body: Record<string, unknown> = { content: args.content };
  if (args.target.threadId) {
    body.message_reference = { message_id: args.target.threadId };
  }
  if (args.components && args.components.length > 0) {
    body.components = args.components;
  }
  return {
    url: `${args.apiBaseUrl}/channels/${args.target.chatId}/messages`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bot ${args.token}`,
    },
    body: JSON.stringify(body),
  };
}

/** Human-readable approval prompt (Discord markdown, not HTML). */
export function formatApprovalPrompt(req: ApprovalReq): string {
  const tag = req.isDestructive ? "⚠️ **DESTRUCTIVE**" : "tool";
  const diff = req.diffPreview ? `\n\n\`\`\`diff\n${req.diffPreview}\n\`\`\`` : "";
  return `🔐 Approval (${tag}): **${req.toolName}**\n${req.description}${diff}`;
}

/**
 * Discord button row for Allow/Deny. `custom_id` encodes the choice + request
 * id (same `allow:<id>` / `deny:<id>` scheme as Telegram's callback_data).
 */
export function buildApprovalComponents(
  requestId: string,
): { components: unknown[] } {
  return {
    components: [
      {
        type: 1, // ACTION_ROW
        components: [
          { type: 2, style: 3, label: "✅ Allow", custom_id: `allow:${requestId}` },
          { type: 2, style: 4, label: "❌ Deny", custom_id: `deny:${requestId}` },
        ],
      },
    ],
  };
}

/** Parse a button `custom_id` ("allow:<id>" | "deny:<id>"). */
export function parseApprovalButton(
  customId: string,
): { choice: "allow" | "deny"; requestId: string } | null {
  const idx = customId.indexOf(":");
  if (idx < 0) return null;
  const choice = customId.slice(0, idx);
  const requestId = customId.slice(idx + 1);
  if ((choice !== "allow" && choice !== "deny") || requestId.length === 0) return null;
  return { choice, requestId };
}

// ── adapter ────────────────────────────────────────────────────────────

export interface DiscordAdapterOptions {
  /** Keyring key for the bot token. Default `discord/bot-token`. */
  botTokenKey?: string;
  /** REST API base. Default `https://discord.com/api/v10`. */
  apiBaseUrl?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable WebSocket constructor (tests). Defaults to `ws`. */
  WebSocketCtor?: typeof WebSocket;
}

interface PendingApproval {
  requestId: string;
  resolve: (choice: "allow" | "deny") => void;
}

// Gateway intents: GUILD_MESSAGES(1<<9) | DIRECT_MESSAGES(1<<13) | MESSAGE_CONTENT(1<<15)
const INTENTS = (1 << 9) | (1 << 13) | (1 << 15);

interface GatewayPayload {
  op: number;
  t?: string | null;
  s?: number | null;
  d?: unknown;
}

export function createDiscordAdapter(
  cfg: AdapterConfig,
  ctx: AdapterContext,
): ChannelAdapter {
  const o = (cfg.options ?? {}) as DiscordAdapterOptions;
  const tokenKey = o.botTokenKey ?? "discord/bot-token";
  const apiBaseUrl = (o.apiBaseUrl ?? "https://discord.com/api/v10").replace(/\/+$/, "");
  const fetchImpl = o.fetchImpl ?? fetch;
  const WebSocketCtor = o.WebSocketCtor ?? WebSocket;

  let token: string | null = null;
  let onMessage: ((m: NormalizedInbound) => void) | null = null;
  let socket: WebSocket | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let lastSeq: number | null = null;
  let running = false;
  const pending = new Map<string, PendingApproval>();

  async function getGatewayUrl(): Promise<string> {
    const res = await fetchImpl(`${apiBaseUrl}/gateway/bot`, {
      headers: { authorization: `Bot ${token}` },
    });
    if (!res.ok) throw new Error(`discord gateway/bot failed: HTTP ${res.status}`);
    const data = (await res.json()) as { url?: string };
    if (typeof data.url !== "string" || data.url.length === 0) {
      throw new Error("discord gateway/bot returned no url");
    }
    // Discord returns `wss://gateway.discord.gg`; pin version + json encoding.
    return `${data.url}?v=10&encoding=json`;
  }

  function handleDispatch(t: string, d: unknown): void {
    if (t === "MESSAGE_CREATE") {
      const n = normalizeDiscordMessage(d);
      if (n) onMessage?.(n);
      return;
    }
    if (t === "INTERACTION_CREATE") {
      handleInteraction(d as DcInteraction);
    }
  }

  function handleInteraction(ix: DcInteraction): void {
    const customId = ix.data?.custom_id;
    if (typeof customId !== "string") return;
    const parsed = parseApprovalButton(customId);
    if (!parsed) return;
    const p = pending.get(parsed.requestId);
    if (!p) return;
    pending.delete(parsed.requestId);
    p.resolve(parsed.choice);
    // Ack the interaction so Discord doesn't show "interaction failed".
    // type 6 = UPDATE_MESSAGE (we'd edit to remove buttons); keep it best-effort.
    void ackInteraction(ix).catch((err) =>
      ctx.logger.warn(`discord interaction ack failed: ${(err as Error).message}`),
    );
  }

  async function ackInteraction(ix: DcInteraction): Promise<void> {
    if (!token) return;
    await fetchImpl(`${apiBaseUrl}/interactions/${ix.id}/${ix.token}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bot ${token}` },
      body: JSON.stringify({
        type: 6, // UPDATE_MESSAGE
        data: { content: ix.data?.custom_id?.startsWith("allow") ? "✅ Approved" : "❌ Denied" },
      }),
    });
  }

  function onGatewayFrame(data: RawData): void {
    const payload = parseJson(data);
    if (!payload) return;
    if (typeof payload.s === "number") lastSeq = payload.s;
    switch (payload.op) {
      case 10: // HELLO
        startHeartbeat(payload);
        sendIdentify();
        break;
      case 0: // DISPATCH
        if (payload.t) handleDispatch(payload.t, payload.d);
        break;
      case 11: // HEARTBEAT_ACK
        break;
      default:
        break;
    }
  }

  function startHeartbeat(hello: GatewayPayload): void {
    const interval =
      typeof (hello.d as { heartbeat_interval?: unknown } | null)?.heartbeat_interval === "number"
        ? (hello.d as { heartbeat_interval: number }).heartbeat_interval
        : 41250;
    stopHeartbeat();
    heartbeat = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ op: 1, d: lastSeq }));
      }
    }, interval);
  }

  function stopHeartbeat(): void {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  function sendIdentify(): void {
    if (!socket || !token) return;
    socket.send(
      JSON.stringify({
        op: 2,
        d: {
          token,
          intents: INTENTS,
          properties: { os: "linux", browser: "shannon-gateway", device: "shannon-gateway" },
        },
      }),
    );
  }

  async function doSend(
    target: ReplyTarget,
    content: string,
    components?: unknown[],
  ): Promise<MessageReceipt> {
    if (!token) throw new Error("discord: start() not called or token missing");
    const req = buildCreateMessageRequest({ token, apiBaseUrl, target, content, components });
    const res = await fetchImpl(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`discord send failed: HTTP ${res.status} ${detail}`);
    }
    const data = (await res.json()) as { id?: string; channel_id?: string };
    return { messageId: data.id ?? "", threadId: data.channel_id };
  }

  return {
    platform: "discord",
    capabilities: {
      threading: false,
      pairing: false,
      approvalButtons: true,
      streaming: "partial",
      editWindowMs: 60 * 60 * 1000, // Discord allows edits for ~1h
    },
    async start(): Promise<void> {
      token = await ctx.getSecret(tokenKey);
      if (!token) throw new Error(`discord: secret "${tokenKey}" missing from keyring`);
      running = true;
      const url = await getGatewayUrl();
      socket = new WebSocketCtor(url);
      socket.on("message", (data: RawData) => onGatewayFrame(data));
      socket.on("close", (code: number, reason: Buffer) => {
        stopHeartbeat();
        if (running) {
          ctx.logger.warn(`discord gateway closed: ${code} ${reason.toString()}`);
          // No auto-resume yet — restart the process to reconnect (real smoke).
        }
      });
      socket.on("error", (err: Error) => {
        ctx.logger.error(`discord gateway error: ${err.message}`);
      });
    },
    async stop(): Promise<void> {
      running = false;
      stopHeartbeat();
      if (socket) {
        try {
          socket.close();
        } catch {
          // ignore — already closed
        }
        socket = null;
      }
    },
    onMessage(handler): void {
      onMessage = handler;
    },
    async send(target, text, _opts?: SendOpts): Promise<MessageReceipt> {
      return await doSend(target, text);
    },
    async requestApproval(target, req): Promise<ApprovalDecision> {
      await doSend(target, formatApprovalPrompt(req), buildApprovalComponents(req.requestId).components);
      return await new Promise<ApprovalDecision>((resolve) => {
        pending.set(req.requestId, {
          requestId: req.requestId,
          resolve: (choice) => resolve({ requestId: req.requestId, choice }),
        });
        // No local timeout: the engine's 300s approval timeout resolves to
        // Deny if no user clicks. Live button wiring = real smoke.
      });
    },
    resolveSessionConversation(rawId): { baseChatId: string } {
      return { baseChatId: rawId };
    },
  };
}

// ── small helpers ──────────────────────────────────────────────────────

function parseJson(data: RawData): GatewayPayload | null {
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else if (Buffer.isBuffer(data)) {
    text = data.toString("utf8");
  } else if (Array.isArray(data)) {
    text = Buffer.concat(data).toString("utf8");
  } else if (data instanceof ArrayBuffer) {
    text = new TextDecoder().decode(data);
  } else if (ArrayBuffer.isView(data)) {
    text = new TextDecoder().decode(data as Uint8Array);
  } else {
    return null;
  }
  try {
    return JSON.parse(text) as GatewayPayload;
  } catch {
    return null;
  }
}
