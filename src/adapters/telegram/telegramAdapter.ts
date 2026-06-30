import {
  type AdapterContext,
  type ApprovalReq,
  type ChannelAdapter,
  type NormalizedInbound,
  type ReplyTarget,
  type SendOpts,
} from "../types.js";
import { type AdapterConfig } from "../../config/types.js";

/**
 * Telegram Bot API adapter.
 *
 * Inbound: long-poll `getUpdates` (webhook mode is a later option). Each Update
 * with a `message.text` is normalized to `NormalizedInbound`.
 *
 * Outbound: `POST /bot<token>/sendMessage`. Telegram has no native threads; it
 * uses reply-to-message quoting, so `capabilities.threading = false` (a whole
 * chat is one session) while `target.threadId` still carries the inbound
 * `message_id` for `reply_to_message_id` UX continuity (F4).
 *
 * Approval: posts the request with an inline Allow/Deny keyboard and resolves
 * on the matching `callback_query`. With no live bot the engine's 300s approval
 * timeout resolves to Deny (safe default).
 *
 * Docs: https://core.telegram.org/bots/api
 */

// ── raw platform shapes (subset we care about) ─────────────────────────

interface TgChat {
  id: number;
  type?: string;
}
interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}
interface TgMessage {
  message_id: number;
  date?: number;
  chat?: TgChat;
  from?: TgUser;
  text?: string;
}
interface TgCallbackQuery {
  id: string;
  data?: string;
  message?: TgMessage;
  from?: TgUser;
}
export interface TgUpdate {
  update_id?: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

// ── pure transforms (unit-tested) ───────────────────────────────────────

/** A Telegram Update → NormalizedInbound, or null if it isn't a text message. */
export function normalizeTelegramUpdate(update: unknown): NormalizedInbound | null {
  if (typeof update !== "object" || update === null) return null;
  const u = update as TgUpdate;
  const msg = u.message;
  if (!msg || typeof msg.text !== "string") return null;
  const chat = msg.chat;
  const from = msg.from;
  if (!chat || !from) return null;
  return {
    platform: "telegram",
    chatId: String(chat.id),
    senderId: String(from.id),
    senderName: from.first_name ?? from.username ?? String(from.id),
    text: msg.text,
    timestamp: typeof msg.date === "number" ? msg.date * 1000 : Date.now(),
    threadId: String(msg.message_id),
    isDirect: chat.type === "private",
    raw: update,
  };
}

export interface SendMessageArgs {
  token: string;
  apiBaseUrl: string;
  target: ReplyTarget;
  text: string;
  /** Extra Telegram sendMessage fields (e.g. reply_markup for approvals). */
  extra?: Record<string, unknown>;
}

export interface HttpRequest {
  url: string;
  method: "POST";
  body: string;
}

/** Build the sendMessage request. Pure — network call lives in `send`. */
export function buildSendMessageRequest(args: SendMessageArgs): HttpRequest {
  const body: Record<string, unknown> = { chat_id: args.target.chatId, text: args.text };
  if (args.target.threadId) body.reply_to_message_id = Number(args.target.threadId);
  if (args.extra) Object.assign(body, args.extra);
  return {
    url: `${args.apiBaseUrl}/bot${args.token}/sendMessage`,
    method: "POST",
    body: JSON.stringify(body),
  };
}

/** Build the editMessageText request (streaming edit-in-place). Pure. */
export function buildEditMessageRequest(args: {
  token: string;
  apiBaseUrl: string;
  target: ReplyTarget;
  text: string;
  messageId: string;
}): HttpRequest {
  return {
    url: `${args.apiBaseUrl}/bot${args.token}/editMessageText`,
    method: "POST",
    body: JSON.stringify({ chat_id: args.target.chatId, message_id: Number(args.messageId), text: args.text }),
  };
}

/** Human-readable approval prompt (shown above the inline buttons). */
export function formatApprovalPrompt(req: ApprovalReq): string {
  const tag = req.isDestructive ? "⚠️ DESTRUCTIVE" : "tool";
  const diff =
    req.diffPreview ? `\n\n<pre>${escapeHtml(req.diffPreview)}</pre>` : "";
  return `🔐 Approval (${tag}): <b>${escapeHtml(req.toolName)}</b>\n${escapeHtml(req.description)}${diff}`;
}

/** Inline keyboard for Allow/Deny. callback_data encodes the choice + request id. */
export function buildApprovalKeyboard(
  requestId: string,
): { reply_markup: { inline_keyboard: unknown[] } } {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Allow", callback_data: `allow:${requestId}` },
          { text: "❌ Deny", callback_data: `deny:${requestId}` },
        ],
      ],
    },
  };
}

/** Parse a callback_data string ("allow:<id>" | "deny:<id>"). */
export function parseApprovalCallback(data: string): { choice: "allow" | "deny"; requestId: string } | null {
  const idx = data.indexOf(":");
  if (idx < 0) return null;
  const choice = data.slice(0, idx);
  const requestId = data.slice(idx + 1);
  if ((choice !== "allow" && choice !== "deny") || requestId.length === 0) return null;
  return { choice, requestId };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── adapter ────────────────────────────────────────────────────────────

export interface TelegramAdapterOptions {
  /** Keyring key for the bot token. Default `telegram/bot-token`. */
  botTokenKey?: string;
  /** API base. Default `https://api.telegram.org`. */
  apiBaseUrl?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Poll interval (ms). Default 1000. */
  pollIntervalMs?: number;
}

interface PendingApproval {
  requestId: string;
  resolve: (choice: "allow" | "deny") => void;
}

export function createTelegramAdapter(
  cfg: AdapterConfig,
  ctx: AdapterContext,
): ChannelAdapter {
  const o = (cfg.options ?? {}) as TelegramAdapterOptions;
  const tokenKey = o.botTokenKey ?? "telegram/bot-token";
  const apiBaseUrl = (o.apiBaseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
  const fetchImpl = o.fetchImpl ?? fetch;
  const pollInterval = o.pollIntervalMs ?? 1000;

  let token: string | null = null;
  let onMessage: ((m: NormalizedInbound) => void) | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let offset = 0;
  let running = false;
  const pending = new Map<string, PendingApproval>();

  async function poll(): Promise<void> {
    if (!running || !token) return;
    try {
      const res = await fetchImpl(
        `${apiBaseUrl}/bot${token}/getUpdates?offset=${offset}&timeout=30`,
      );
      const data = (await res.json()) as { result?: TgUpdate[] };
      for (const upd of data.result ?? []) {
        if (typeof upd.update_id === "number") offset = upd.update_id + 1;
        if (upd.callback_query) {
          const parsed = upd.callback_query.data ? parseApprovalCallback(upd.callback_query.data) : null;
          if (parsed) {
            const p = pending.get(parsed.requestId);
            if (p) {
              p.resolve(parsed.choice);
              pending.delete(parsed.requestId);
            }
          }
          continue;
        }
        const n = normalizeTelegramUpdate(upd);
        if (n) onMessage?.(n);
      }
    } catch (err) {
      ctx.logger.warn(`telegram poll failed: ${(err as Error).message}`);
    }
    if (running) pollTimer = setTimeout(() => void poll(), pollInterval);
  }

  async function doSend(
    target: ReplyTarget,
    text: string,
    extra?: Record<string, unknown>,
  ): Promise<string> {
    if (!token) throw new Error("telegram: start() not called or token missing");
    const req = buildSendMessageRequest({ token, apiBaseUrl, target, text, extra });
    const res = await fetchImpl(req.url, {
      method: req.method,
      body: req.body,
      headers: { "content-type": "application/json" },
    });
    if (!res.ok) throw new Error(`telegram send failed: HTTP ${res.status}`);
    const data = (await res.json()) as { result?: { message_id?: number } };
    return String(data.result?.message_id ?? "");
  }

  async function doEdit(target: ReplyTarget, text: string, messageId: string): Promise<void> {
    if (!token) throw new Error("telegram: start() not called or token missing");
    const req = buildEditMessageRequest({ token, apiBaseUrl, target, text, messageId });
    const res = await fetchImpl(req.url, {
      method: req.method,
      body: req.body,
      headers: { "content-type": "application/json" },
    });
    if (!res.ok) throw new Error(`telegram edit failed: HTTP ${res.status}`);
  }

  return {
    platform: "telegram",
    capabilities: {
      threading: false,
      pairing: false,
      approvalButtons: true,
      streaming: "partial",
    },
    async start(): Promise<void> {
      token = await ctx.getSecret(tokenKey);
      if (!token) throw new Error(`telegram: secret "${tokenKey}" missing from keyring`);
      running = true;
      void poll();
    },
    async stop(): Promise<void> {
      running = false;
      if (pollTimer) clearTimeout(pollTimer);
    },
    onMessage(handler): void {
      onMessage = handler;
    },
    async send(target, text, opts?: SendOpts): Promise<{ messageId: string }> {
      if (opts?.editMessageId) {
        await doEdit(target, text, opts.editMessageId);
        return { messageId: opts.editMessageId };
      }
      const messageId = await doSend(target, text);
      return { messageId };
    },
    async requestApproval(target, req): Promise<{ requestId: string; choice: "allow" | "deny" }> {
      await doSend(target, formatApprovalPrompt(req), buildApprovalKeyboard(req.requestId));
      return await new Promise<{ requestId: string; choice: "allow" | "deny" }>((resolve) => {
        pending.set(req.requestId, {
          requestId: req.requestId,
          resolve: (choice) => resolve({ requestId: req.requestId, choice }),
        });
        // No timeout here: the engine's own 300s approval timeout resolves to
        // Deny if no user ever taps a button. Live callback wiring = real smoke.
      });
    },
    resolveSessionConversation(rawId): { baseChatId: string } {
      return { baseChatId: rawId };
    },
  };
}
