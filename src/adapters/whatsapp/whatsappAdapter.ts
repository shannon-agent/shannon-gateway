import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

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
 * WhatsApp adapter (Meta Cloud API, a.k.a. WhatsApp Business Platform).
 *
 * Inbound: Meta sends **webhook** POSTs to a configurable URL. This adapter
 * runs a minimal `node:http` server (no extra deps) on `webhookPort` that:
 *   - answers the `GET` subscription handshake (hub.mode/hub.verify_token/
 *     hub.challenge);
 *   - verifies the `x-hub-signature-256` HMAC (when `appSecret` is set);
 *   - dispatches text messages and interactive button replies.
 * There is no long-poll alternative for inbound — Meta pushes to you.
 *
 * Outbound: `POST https://graph.facebook.com/v<version>/<phone_number_id>/messages`
 * with `Authorization: Bearer <token>`.
 *
 * Sessions: a WhatsApp conversation is 1:1 with a phone number, so
 * `chatId = from` (the E.164 phone), `isDirect = true`, `threading = false`.
 *
 * Approval: WhatsApp Cloud API supports **interactive button messages**, so
 * `approvalButtons = true`. The request is rendered as two buttons; a click
 * arrives as a `button_reply` webhook, resolved against the pending promise.
 * Engine 300s timeout → Deny.
 *
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */

// ── raw platform shapes (subset) ────────────────────────────────────────

interface WaMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  interactive?: { type?: string; button_reply?: { id?: string; title?: string } };
}
interface WaContact {
  wa_id?: string;
  profile?: { name?: string };
}
interface WaValue {
  messaging_product?: string;
  metadata?: { phone_number_id?: string };
  messages?: WaMessage[];
  contacts?: WaContact[];
}
interface WaChange {
  value?: WaValue;
}
interface WaWebhookBody {
  object?: string;
  entry?: Array<{ changes?: WaChange[] }>;
}

// ── pure transforms (unit-tested) ───────────────────────────────────────

export interface WaInbound {
  messages: NormalizedInbound[];
  buttonReplies: Array<{ buttonId: string; from: string }>;
}

/** Pull text messages + button replies out of a Meta webhook body. Pure. */
export function extractInbound(body: unknown): WaInbound {
  const messages: NormalizedInbound[] = [];
  const buttonReplies: Array<{ buttonId: string; from: string }> = [];
  if (typeof body !== "object" || body === null) return { messages, buttonReplies };
  const wb = body as WaWebhookBody;
  for (const entry of wb.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value?.messages) continue;
      const nameByPhone = new Map<string, string>();
      for (const c of value.contacts ?? []) {
        if (c.wa_id && c.profile?.name) nameByPhone.set(c.wa_id, c.profile.name);
      }
      for (const msg of value.messages) {
        const from = msg.from;
        if (typeof from !== "string") continue;
        // Button reply → approval resolution candidate.
        if (msg.type === "interactive" && msg.interactive?.button_reply?.id) {
          buttonReplies.push({ buttonId: msg.interactive.button_reply.id, from });
          continue;
        }
        if (msg.type === "text" && typeof msg.text?.body === "string" && msg.text.body.length > 0) {
          messages.push({
            platform: "whatsapp",
            chatId: from,
            senderId: from,
            senderName: nameByPhone.get(from) ?? from,
            text: msg.text.body,
            timestamp: parseTimestamp(msg.timestamp),
            threadId: msg.id,
            isDirect: true,
            raw: msg,
          });
        }
      }
    }
  }
  return { messages, buttonReplies };
}

function parseTimestamp(s: string | undefined): number {
  if (typeof s !== "string") return Date.now();
  const t = Number.parseInt(s, 10);
  return Number.isFinite(t) ? t * 1000 : Date.now();
}

export interface WaSendArgs {
  apiBase: string;
  version: string;
  phoneNumberId: string;
  accessToken: string;
  to: string;
  body: string;
  /** Interactive buttons (approval). */
  interactive?: unknown;
}

export interface WaRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/** Build the send-message request. Pure — network call lives in `send`. */
export function buildSendRequest(args: WaSendArgs): WaRequest {
  const payload = args.interactive
    ? { messaging_product: "whatsapp", to: args.to, type: "interactive", interactive: args.interactive }
    : { messaging_product: "whatsapp", to: args.to, type: "text", text: { body: args.body } };
  return {
    url: `${args.apiBase}/${args.version}/${args.phoneNumberId}/messages`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.accessToken}`,
    },
    body: JSON.stringify(payload),
  };
}

/** Human-readable approval prompt body. */
export function formatApprovalPrompt(req: ApprovalReq): string {
  const tag = req.isDestructive ? "⚠️ DESTRUCTIVE" : "tool";
  const diff = req.diffPreview ? `\n\n${req.diffPreview}` : "";
  return `🔐 Approval (${tag}): ${req.toolName}\n${req.description}${diff}`;
}

/**
 * WhatsApp interactive button message. Max 3 buttons; we use 2. Each button's
 * `id` encodes the choice + request id (button_reply returns the id).
 */
export function buildApprovalInteractive(
  requestId: string,
  bodyText: string,
): { type: "button"; body: { text: string }; action: { buttons: unknown[] } } {
  return {
    type: "button",
    body: { text: bodyText },
    action: {
      buttons: [
        { type: "reply", reply: { id: `allow:${requestId}`, title: "✅ Allow" } },
        { type: "reply", reply: { id: `deny:${requestId}`, title: "❌ Deny" } },
      ],
    },
  };
}

/** Parse a button_reply id ("allow:<id>" | "deny:<id>"). */
export function parseApprovalButton(
  buttonId: string,
): { choice: "allow" | "deny"; requestId: string } | null {
  const idx = buttonId.indexOf(":");
  if (idx < 0) return null;
  const choice = buttonId.slice(0, idx);
  const requestId = buttonId.slice(idx + 1);
  if ((choice !== "allow" && choice !== "deny") || requestId.length === 0) return null;
  return { choice, requestId };
}

/** Verify the Meta `x-hub-signature-256` header (`sha256=<hex>`). Pure. */
export function verifyHubSignature(
  rawBody: string,
  signatureHeader: string,
  appSecret: string,
): boolean {
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;
  const expected = Buffer.from(signatureHeader.slice(prefix.length), "hex");
  const mac = createHmac("sha256", appSecret).update(rawBody).digest();
  if (mac.length !== expected.length) return false;
  return timingSafeEqual(mac, expected);
}

/** Webhook subscription handshake check. Pure. */
export function verifySubscription(
  query: Record<string, string | string[] | undefined>,
  verifyToken: string,
): string | null {
  const mode = asString(query["hub.mode"]);
  const token = asString(query["hub.verify_token"]);
  const challenge = asString(query["hub.challenge"]);
  if (mode === "subscribe" && token === verifyToken && typeof challenge === "string") {
    return challenge;
  }
  return null;
}

function asString(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// ── adapter ────────────────────────────────────────────────────────────

export interface WhatsAppAdapterOptions {
  /** Keyring key for the permanent access token. Default `whatsapp/access-token`. */
  accessTokenKey?: string;
  /** Cloud API base. Default `https://graph.facebook.com`. */
  apiBase?: string;
  /** API version. Default `v20.0`. */
  version?: string;
  /** The sending phone number's id (from webhook metadata or Meta console). */
  phoneNumberId: string;
  /** Webhook verify token (chosen by you, set in the Meta console). */
  verifyToken: string;
  /** App secret for HMAC signature verification (optional but recommended). */
  appSecret?: string;
  /** Keyring key for appSecret if you keep it in the keyring. Default none (option). */
  appSecretKey?: string;
  /** Local port to listen on. Default 9876. */
  webhookPort?: number;
  /** Webhook path. Default `/whatsapp`. */
  webhookPath?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

interface PendingApproval {
  requestId: string;
  resolve: (choice: "allow" | "deny") => void;
}

export function createWhatsAppAdapter(
  cfg: AdapterConfig,
  ctx: AdapterContext,
): ChannelAdapter {
  const o = (cfg.options ?? {}) as unknown as WhatsAppAdapterOptions;
  const tokenKey = o.accessTokenKey ?? "whatsapp/access-token";
  const apiBase = (o.apiBase ?? "https://graph.facebook.com").replace(/\/+$/, "");
  const version = o.version ?? "v20.0";
  if (typeof o.phoneNumberId !== "string" || o.phoneNumberId.length === 0) {
    throw new Error("whatsapp: options.phoneNumberId is required");
  }
  if (typeof o.verifyToken !== "string" || o.verifyToken.length === 0) {
    throw new Error("whatsapp: options.verifyToken is required (webhook handshake)");
  }
  const phoneNumberId = o.phoneNumberId;
  const verifyToken = o.verifyToken;
  const appSecretKey = o.appSecretKey;
  const webhookPort = o.webhookPort ?? 9876;
  const webhookPath = o.webhookPath ?? "/whatsapp";
  const fetchImpl = o.fetchImpl ?? fetch;

  let token: string | null = null;
  let appSecret: string | null = null;
  let onMessage: ((m: NormalizedInbound) => void) | null = null;
  let server: Server | null = null;
  const pending = new Map<string, PendingApproval>();

  function handleButtonReply(buttonId: string): void {
    const parsed = parseApprovalButton(buttonId);
    if (!parsed) return;
    const p = pending.get(parsed.requestId);
    if (!p) return;
    pending.delete(parsed.requestId);
    p.resolve(parsed.choice);
  }

  async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    if (appSecret) {
      const sig = header(req, "x-hub-signature-256");
      if (!sig || !verifyHubSignature(raw, sig, appSecret)) {
        res.statusCode = 401;
        res.end("bad signature");
        return;
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      res.statusCode = 400;
      res.end("bad json");
      return;
    }
    const { messages, buttonReplies } = extractInbound(parsed);
    for (const b of buttonReplies) handleButtonReply(b.buttonId);
    for (const m of messages) onMessage?.(m);
    res.statusCode = 200;
    res.end("ok");
  }

  function handleGet(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== webhookPath) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const query: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of url.searchParams.entries()) {
      query[k] = v;
    }
    const challenge = verifySubscription(query, verifyToken);
    if (challenge === null) {
      res.statusCode = 403;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.end(challenge);
  }

  async function doSend(target: ReplyTarget, bodyText: string, interactive?: unknown): Promise<MessageReceipt> {
    if (!token) throw new Error("whatsapp: start() not called or token missing");
    const req = buildSendRequest({
      apiBase,
      version,
      phoneNumberId,
      accessToken: token,
      to: target.chatId,
      body: bodyText,
      interactive,
    });
    const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`whatsapp send failed: HTTP ${res.status} ${detail}`);
    }
    const data = (await res.json()) as { messages?: Array<{ id?: string }> };
    return { messageId: data.messages?.[0]?.id ?? "" };
  }

  // (handler signatures use node:http's ServerResponse directly above)

  return {
    platform: "whatsapp",
    capabilities: {
      threading: false,
      pairing: false,
      approvalButtons: true,
      streaming: "none", // WhatsApp has no per-message edit window
    },
    async start(): Promise<void> {
      token = await ctx.getSecret(tokenKey);
      if (!token) throw new Error(`whatsapp: secret "${tokenKey}" missing from keyring`);
      if (appSecretKey) appSecret = await ctx.getSecret(appSecretKey);
      server = createServer((req, res) => {
        if (req.method === "GET") {
          handleGet(req, res);
        } else if (req.method === "POST") {
          void handlePost(req, res).catch((err) => {
            ctx.logger.warn(`whatsapp webhook POST failed: ${(err as Error).message}`);
            try {
              res.statusCode = 500;
              res.end("error");
            } catch {
              // ignore
            }
          });
        } else {
          res.statusCode = 405;
          res.end();
        }
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(webhookPort, () => {
          server!.off("error", reject);
          resolve();
        });
      });
      ctx.logger.info(`whatsapp webhook listening on :${webhookPort}${webhookPath}`);
    },
    async stop(): Promise<void> {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
    },
    onMessage(handler): void {
      onMessage = handler;
    },
    async send(target, text, _opts?: SendOpts): Promise<MessageReceipt> {
      return await doSend(target, text);
    },
    async requestApproval(target, req): Promise<ApprovalDecision> {
      const interactive = buildApprovalInteractive(req.requestId, formatApprovalPrompt(req));
      await doSend(target, "", interactive);
      return await new Promise<ApprovalDecision>((resolve) => {
        pending.set(req.requestId, {
          requestId: req.requestId,
          resolve: (choice) => resolve({ requestId: req.requestId, choice }),
        });
        // Engine 300s approval timeout → Deny if no button click arrives.
      });
    },
    resolveSessionConversation(rawId): { baseChatId: string } {
      return { baseChatId: rawId };
    },
  };
}

// ── small helpers ──────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}
