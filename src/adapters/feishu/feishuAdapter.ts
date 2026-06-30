import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

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
 * Feishu / Lark (飞书) adapter (Open Platform IM API).
 *
 * Inbound: Feishu pushes **event subscription** POSTs to a callback URL. When
 * an `Encrypt Key` is configured, the body is `{ "encrypt": "<base64>" }`
 * AES-256-CBC (key = SHA256(encrypt_key), IV = key[0:16], **standard** PKCS7
 * on 16-byte AES blocks — distinct from WeCom's custom 32-byte scheme).
 * The decrypted payload is JSON: either a `url_verification` challenge (echo
 * `challenge`) or an `im.message.receive_v1` message event. A card button
 * click arrives as a `card.action.trigger` event whose `value` carries the
 * choice + request id.
 *
 * Outbound: `tenant_access_token` flow (app_id + app_secret → token, cached),
 * then `POST /open-apis/im/v1/messages?receive_id_type=…` with text or an
 * interactive card.
 *
 * Sessions: a Feishu chat is the session unit (`chatId = chat_id`,
 * `threading = false`); the inbound `message_id` is carried as `threadId`.
 *
 * Approval: Feishu **interactive cards** have real buttons (`approvalButtons
 * = true`). The request is rendered as an action row with Allow/Deny buttons;
 * a click's `value` resolves the pending promise. Engine 300s timeout → Deny.
 *
 * Docs: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create
 */

// ── crypto (pure, round-trip tested) ────────────────────────────────────

function feishuKey(encryptKey: string): Buffer {
  return createHash("sha256").update(encryptKey).digest();
}

/** Encrypt a JSON payload the way Feishu wraps event bodies (standard PKCS7). */
export function encryptFeishuPayload(json: string, encryptKey: string): string {
  const key = feishuKey(encryptKey);
  const iv = key.subarray(0, 16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([cipher.update(json, "utf8"), cipher.final()]).toString("base64");
}

/** Decrypt a Feishu `{ encrypt }` body → the inner JSON string. */
export function decryptFeishuPayload(encryptBase64: string, encryptKey: string): string {
  const key = feishuKey(encryptKey);
  const iv = key.subarray(0, 16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([
    decipher.update(Buffer.from(encryptBase64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

// ── inbound normalization (pure) ────────────────────────────────────────

interface FeishuEvent {
  schema?: string;
  header?: { event_type?: string; event_id?: string };
  event?: {
    sender?: { sender_id?: { open_id?: string; user_id?: string } };
    message?: {
      message_id?: string;
      chat_id?: string;
      message_type?: string;
      content?: string; // JSON string
      chat_type?: string; // "p2p" | "group"
      create_time?: string;
    };
    action?: { value?: Record<string, unknown> };
  };
  type?: string; // "url_verification"
  challenge?: string;
}

/** Parse + normalize a decrypted Feishu event envelope. */
export function normalizeFeishuEvent(
  payload: unknown,
): { kind: "message"; message: NormalizedInbound } | { kind: "challenge"; challenge: string } | {
  kind: "button";
  value: Record<string, unknown>;
  chatId: string;
} | { kind: "ignore" } {
  if (typeof payload !== "object" || payload === null) return { kind: "ignore" };
  const ev = payload as FeishuEvent;

  if (ev.type === "url_verification" && typeof ev.challenge === "string") {
    return { kind: "challenge", challenge: ev.challenge };
  }

  const eventType = ev.header?.event_type;
  if (eventType === "card.action.trigger") {
    const chatId = ev.event?.message?.chat_id ?? "";
    const value = ev.event?.action?.value;
    return value ? { kind: "button", value, chatId } : { kind: "ignore" };
  }

  if (eventType === "im.message.receive_v1") {
    const msg = ev.event?.message;
    const senderId = ev.event?.sender?.sender_id?.open_id ?? ev.event?.sender?.sender_id?.user_id;
    if (!msg || typeof msg.content !== "string" || typeof senderId !== "string") {
      return { kind: "ignore" };
    }
    const text = extractTextContent(msg.content);
    if (text === null) return { kind: "ignore" };
    const ts = msg.create_time ? Number(msg.create_time) : Date.now();
    return {
      kind: "message",
      message: {
        platform: "feishu",
        chatId: msg.chat_id ?? senderId,
        senderId,
        senderName: senderId,
        text,
        timestamp: Number.isFinite(ts) ? ts : Date.now(),
        threadId: msg.message_id,
        isDirect: msg.chat_type === "p2p",
        raw: payload,
      },
    };
  }

  return { kind: "ignore" };
}

/** Pull `.text` out of a Feishu text message content JSON string. */
export function extractTextContent(contentJson: string): string | null {
  try {
    const parsed = JSON.parse(contentJson) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : null;
  } catch {
    return null;
  }
}

// ── outbound request builders (pure) ────────────────────────────────────

export interface FeishuSendArgs {
  apiBase: string;
  tenantAccessToken: string;
  receiveId: string;
  receiveIdType: string;
  msgType: "text" | "interactive";
  /** JSON string placed in the `content` field. */
  contentJson: string;
}

export interface FeishuRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export function buildSendRequest(args: FeishuSendArgs): FeishuRequest {
  return {
    url: `${args.apiBase}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(args.receiveIdType)}`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.tenantAccessToken}`,
    },
    body: JSON.stringify({
      receive_id: args.receiveId,
      msg_type: args.msgType,
      content: args.contentJson,
    }),
  };
}

/** Text content JSON for a plain message. */
export function textContent(text: string): string {
  return JSON.stringify({ text });
}

export function formatApprovalPrompt(req: ApprovalReq): string {
  const tag = req.isDestructive ? "⚠️ 危险操作" : "工具";
  const diff = req.diffPreview ? `\n\n${req.diffPreview}` : "";
  return `🔐 审批 (${tag}): ${req.toolName}\n${req.description}${diff}`;
}

/** Feishu interactive card with Allow/Deny buttons. The button `value` is the
 *  blob returned on click — encode choice + requestId there. */
export function buildApprovalCard(requestId: string, prompt: string): string {
  const card = {
    elements: [
      { tag: "div", text: { tag: "lark_md", content: prompt } },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "✅ 允许" },
            type: "primary",
            value: { choice: "allow", requestId },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "❌ 拒绝" },
            type: "danger",
            value: { choice: "deny", requestId },
          },
        ],
      },
    ],
  };
  return JSON.stringify(card);
}

/** Read the choice + requestId out of a clicked button's value. */
export function parseButtonValue(
  value: Record<string, unknown>,
): { choice: "allow" | "deny"; requestId: string } | null {
  const choice = value.choice;
  const requestId = value.requestId;
  if ((choice !== "allow" && choice !== "deny") || typeof requestId !== "string" || requestId.length === 0) {
    return null;
  }
  return { choice, requestId };
}

// ── adapter ────────────────────────────────────────────────────────────

export interface FeishuAdapterOptions {
  /** Keyring key for the app secret. Default `feishu/app-secret`. */
  appSecretKey?: string;
  /** Keyring key for the event Encrypt Key. Default `feishu/encrypt-key`. */
  encryptKeyKey?: string;
  /** API base. Default `https://open.feishu.cn`. */
  apiBase?: string;
  /** App id (from the Feishu developer console). */
  appId: string;
  /** receive_id_type for outbound sends. Default `open_id`. */
  receiveIdType?: string;
  /** Local callback port. Default 9875. */
  webhookPort?: number;
  /** Callback path. Default `/feishu`. */
  webhookPath?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

interface PendingApproval {
  requestId: string;
  resolve: (choice: "allow" | "deny") => void;
}

interface TokenCache {
  value: string;
  expiresAt: number;
}

export function createFeishuAdapter(cfg: AdapterConfig, ctx: AdapterContext): ChannelAdapter {
  const o = (cfg.options ?? {}) as unknown as FeishuAdapterOptions;
  const appSecretKey = o.appSecretKey ?? "feishu/app-secret";
  const encryptKeyKey = o.encryptKeyKey ?? "feishu/encrypt-key";
  const apiBase = (o.apiBase ?? "https://open.feishu.cn").replace(/\/+$/, "");
  if (typeof o.appId !== "string" || o.appId.length === 0) {
    throw new Error("feishu: options.appId is required");
  }
  const appId = o.appId;
  const receiveIdType = o.receiveIdType ?? "open_id";
  const webhookPort = o.webhookPort ?? 9875;
  const webhookPath = o.webhookPath ?? "/feishu";
  const fetchImpl = o.fetchImpl ?? fetch;

  let appSecret: string | null = null;
  let encryptKey: string | null = null;
  let onMessage: ((m: NormalizedInbound) => void) | null = null;
  let server: Server | null = null;
  let tokenCache: TokenCache | null = null;
  const pending = new Map<string, PendingApproval>();

  async function ensureTenantToken(): Promise<string> {
    if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
      return tokenCache.value;
    }
    const res = await fetchImpl(`${apiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret ?? "" }),
    });
    if (!res.ok) throw new Error(`feishu tenant_token HTTP ${res.status}`);
    const data = (await res.json()) as { code?: number; tenant_access_token?: string; expire?: number };
    if (typeof data.tenant_access_token !== "string") {
      throw new Error(`feishu tenant_token failed: code=${data.code ?? "n/a"}`);
    }
    tokenCache = {
      value: data.tenant_access_token,
      expiresAt: Date.now() + (typeof data.expire === "number" ? data.expire * 1000 : 7200_000),
    };
    return tokenCache.value;
  }

  function resolveButton(value: Record<string, unknown>): void {
    const parsed = parseButtonValue(value);
    if (!parsed) return;
    const p = pending.get(parsed.requestId);
    if (!p) return;
    pending.delete(parsed.requestId);
    p.resolve(parsed.choice);
  }

  async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      res.statusCode = 400;
      res.end("bad json");
      return;
    }
    // Unwrap encryption envelope if present.
    const envelope = parsed as { encrypt?: string };
    if (typeof envelope.encrypt === "string") {
      if (!encryptKey) {
        res.statusCode = 500;
        res.end("no encrypt key");
        return;
      }
      try {
        parsed = JSON.parse(decryptFeishuPayload(envelope.encrypt, encryptKey));
      } catch (err) {
        ctx.logger.warn(`feishu decrypt failed: ${(err as Error).message}`);
        res.statusCode = 400;
        res.end("decrypt failed");
        return;
      }
    }
    const result = normalizeFeishuEvent(parsed);
    switch (result.kind) {
      case "challenge":
        res.statusCode = 200;
        res.end(JSON.stringify({ challenge: result.challenge }));
        return;
      case "message":
        onMessage?.(result.message);
        break;
      case "button":
        resolveButton(result.value);
        break;
      default:
        break;
    }
    res.statusCode = 200;
    res.end();
  }

  async function doSend(
    target: ReplyTarget,
    msgType: "text" | "interactive",
    contentJson: string,
  ): Promise<MessageReceipt> {
    const token = await ensureTenantToken();
    const req = buildSendRequest({
      apiBase,
      tenantAccessToken: token,
      receiveId: target.chatId,
      receiveIdType,
      msgType,
      contentJson,
    });
    const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`feishu send failed: HTTP ${res.status} ${detail}`);
    }
    const data = (await res.json()) as { code?: number; data?: { message_id?: string } };
    if (data.code) {
      throw new Error(`feishu send code=${data.code}`);
    }
    return { messageId: data.data?.message_id ?? "" };
  }

  return {
    platform: "feishu",
    capabilities: {
      threading: false,
      pairing: false,
      approvalButtons: true, // interactive cards
      streaming: "partial",
    },
    async start(): Promise<void> {
      appSecret = await ctx.getSecret(appSecretKey);
      if (!appSecret) throw new Error(`feishu: secret "${appSecretKey}" missing from keyring`);
      encryptKey = await ctx.getSecret(encryptKeyKey); // optional; null disables encryption
      server = createServer((req, res) => {
        if (req.method === "POST") {
          void handlePost(req, res).catch((err) => {
            ctx.logger.warn(`feishu POST failed: ${(err as Error).message}`);
            res.statusCode = 500;
            res.end();
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
      ctx.logger.info(`feishu callback listening on :${webhookPort}${webhookPath}`);
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
      return await doSend(target, "text", textContent(text));
    },
    async requestApproval(target, req): Promise<ApprovalDecision> {
      const card = buildApprovalCard(req.requestId, formatApprovalPrompt(req));
      await doSend(target, "interactive", card);
      return await new Promise<ApprovalDecision>((resolve) => {
        pending.set(req.requestId, {
          requestId: req.requestId,
          resolve: (choice) => resolve({ requestId: req.requestId, choice }),
        });
        // Engine 300s approval timeout → Deny if no card click arrives.
      });
    },
    resolveSessionConversation(rawId): { baseChatId: string } {
      return { baseChatId: rawId };
    },
  };
}

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
