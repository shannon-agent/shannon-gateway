import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

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
 * WeCom (企业微信 / WeChat Work) adapter.
 *
 * WeCom **encrypts every message callback** with AES-256-CBC (a fixed
 * protocol shared with the official account platform) and signs each request
 * with SHA1(sort(token, timestamp, nonce, ciphertext)). So this adapter's
 * defining work is the crypto layer — `decodeAesKey` / `encryptMessage` /
 * `decryptMessage` / `computeSignature`, all pure and round-trip tested.
 *
 * Inbound: an HTTP callback server (like WhatsApp). The handshake GET carries
 * an encrypted `echostr` that must be signature-checked + decrypted and the
 * plaintext echoed back. Message callbacks arrive as an XML envelope whose
 * `<Encrypt>` payload decrypts to the actual message XML.
 *
 * Outbound: two-step — `gettoken` (corpid + corpsecret → access_token, cached
 * until near-expiry) then `POST /message/send?access_token=...`.
 *
 * Sessions: an app message is 1:1 with a WeCom user id, so `chatId = from`
 * (the UserId), `isDirect = true`, `threading = false`.
 *
 * Approval: WeCom template-card buttons need a separate callback flow; for
 * now `approvalButtons = false` and approval uses the text-reply fallback
 * (post the prompt, intercept the next `allow`/`deny` from the same user).
 *
 * Docs: https://developer.work.weixin.qq.com/document/path/90930 (crypto),
 *       https://developer.work.weixin.qq.com/document/path/90236 (send).
 */

// ── crypto (pure, round-trip tested) ────────────────────────────────────

/** Decode WeCom's 43-char EncodingAESKey to the 32-byte AES key. */
export function decodeAesKey(encodingAESKey: string): Buffer {
  return Buffer.from(`${encodingAESKey}=`, "base64");
}

const BLOCK_SIZE = 32;

function pkcs7Pad(buf: Buffer): Buffer {
  const pad = BLOCK_SIZE - (buf.length % BLOCK_SIZE);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

function pkcs7Unpad(buf: Buffer): Buffer {
  const pad = buf[buf.length - 1];
  if (pad === undefined || pad < 1 || pad > BLOCK_SIZE) {
    throw new Error("wecom: bad PKCS7 padding");
  }
  return buf.subarray(0, buf.length - pad);
}

export interface EncryptedPayload {
  message: string;
  appId: string;
}

/** Encrypt a plaintext message (random+length+msg+appId, PKCS7, AES-256-CBC). */
export function encryptMessage(plain: string, appId: string, aesKey: Buffer): string {
  const iv = aesKey.subarray(0, 16);
  const random = randomBytes(16);
  const msg = Buffer.from(plain, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(msg.length, 0);
  const raw = Buffer.concat([random, len, msg, Buffer.from(appId, "utf8")]);
  const cipher = createCipheriv("aes-256-cbc", aesKey, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(pkcs7Pad(raw)), cipher.final()]).toString("base64");
}

/** Decrypt a base64 ciphertext → { message, appId }. */
export function decryptMessage(ciphertext: string, aesKey: Buffer): EncryptedPayload {
  const iv = aesKey.subarray(0, 16);
  const decipher = createDecipheriv("aes-256-cbc", aesKey, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]);
  const unpadded = pkcs7Unpad(decrypted);
  const msgLen = unpadded.readUInt32BE(16);
  const message = unpadded.subarray(20, 20 + msgLen).toString("utf8");
  const appId = unpadded.subarray(20 + msgLen).toString("utf8");
  return { message, appId };
}

/** SHA1(sort([token, timestamp, nonce, encrypted])).sort().join("")) → hex. */
export function computeSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypted: string,
): string {
  return createHash("sha1")
    .update([token, timestamp, nonce, encrypted].sort().join(""))
    .digest("hex");
}

export function verifySignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypted: string,
  provided: string,
): boolean {
  return computeSignature(token, timestamp, nonce, encrypted) === provided;
}

// ── XML helpers (CDATA-aware; no XML dep) ───────────────────────────────

export function xmlField(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  if (!m || m[1] === undefined) return undefined;
  let v = m[1].trim();
  if (v.startsWith("<![CDATA[") && v.endsWith("]]>")) v = v.slice(9, -3);
  return v;
}

/** Extract <Encrypt> from a callback envelope. */
export function extractEncrypt(xml: string): string | undefined {
  return xmlField(xml, "Encrypt");
}

// ── inbound normalization (pure) ────────────────────────────────────────

/** A decrypted WeCom text message XML → NormalizedInbound, or null. */
export function normalizeWecomMessage(xml: string): NormalizedInbound | null {
  if (xmlField(xml, "MsgType") !== "text") return null;
  const content = xmlField(xml, "Content");
  const from = xmlField(xml, "FromUserName");
  if (!content || !from) return null;
  const createTime = xmlField(xml, "CreateTime");
  const msgId = xmlField(xml, "MsgId");
  const ts = createTime ? Number(createTime) * 1000 : Date.now();
  return {
    platform: "wecom",
    chatId: from,
    senderId: from,
    senderName: from,
    text: content,
    timestamp: Number.isFinite(ts) ? ts : Date.now(),
    threadId: msgId,
    isDirect: true,
    raw: xml,
  };
}

/** Recognize a free-text allow/deny reply (buttonless approval fallback). */
export function parseChoice(text: string): "allow" | "deny" | null {
  const t = text.trim().toLowerCase();
  if (["allow", "yes", "y", "同意", "允许", "✅"].includes(t)) return "allow";
  if (["deny", "no", "n", "拒绝", "否", "❌"].includes(t)) return "deny";
  return null;
}

// ── outbound request builders (pure) ────────────────────────────────────

export interface WecomSendArgs {
  apiBase: string;
  accessToken: string;
  touser: string;
  agentId: string;
  content: string;
}

export interface WecomRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export function buildSendRequest(args: WecomSendArgs): WecomRequest {
  return {
    url: `${args.apiBase}/cgi-bin/message/send?access_token=${encodeURIComponent(args.accessToken)}`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      touser: args.touser,
      msgtype: "text",
      agentid: args.agentId,
      text: { content: args.content },
    }),
  };
}

export function formatApprovalPrompt(req: ApprovalReq): string {
  const tag = req.isDestructive ? "⚠️ 危险操作" : "工具";
  const diff = req.diffPreview ? `\n\n${req.diffPreview}` : "";
  return `🔐 审批 (${tag}): ${req.toolName}\n${req.description}${diff}\n— 回复「允许」或「拒绝」`;
}

// ── adapter ────────────────────────────────────────────────────────────

export interface WeComAdapterOptions {
  /** Keyring key for the corpsecret. Default `wecom/corp-secret`. */
  corpSecretKey?: string;
  /** Keyring key for the EncodingAESKey. Default `wecom/encoding-aes-key`. */
  encodingAesKeyKey?: string;
  /** API base. Default `https://qyapi.weixin.qq.com`. */
  apiBase?: string;
  /** Corp id (from the WeCom admin console). */
  corpId: string;
  /** Application agent id (numeric string). */
  agentId: string;
  /** Callback token (signature verification; from the callback config). */
  callbackToken: string;
  /** Local callback port. Default 9877. */
  webhookPort?: number;
  /** Callback path. Default `/wecom`. */
  webhookPath?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

interface PendingApproval {
  requestId: string;
  userId: string;
  resolve: (choice: "allow" | "deny") => void;
}

interface TokenCache {
  value: string;
  expiresAt: number; // epoch ms
}

export function createWeComAdapter(cfg: AdapterConfig, ctx: AdapterContext): ChannelAdapter {
  const o = (cfg.options ?? {}) as unknown as WeComAdapterOptions;
  const corpSecretKey = o.corpSecretKey ?? "wecom/corp-secret";
  const aesKeyKey = o.encodingAesKeyKey ?? "wecom/encoding-aes-key";
  const apiBase = (o.apiBase ?? "https://qyapi.weixin.qq.com").replace(/\/+$/, "");
  if (typeof o.corpId !== "string" || o.corpId.length === 0) {
    throw new Error("wecom: options.corpId is required");
  }
  if (typeof o.agentId !== "string" || o.agentId.length === 0) {
    throw new Error("wecom: options.agentId is required");
  }
  if (typeof o.callbackToken !== "string" || o.callbackToken.length === 0) {
    throw new Error("wecom: options.callbackToken is required");
  }
  const corpId = o.corpId;
  const agentId = o.agentId;
  const callbackToken = o.callbackToken;
  const webhookPort = o.webhookPort ?? 9877;
  const webhookPath = o.webhookPath ?? "/wecom";
  const fetchImpl = o.fetchImpl ?? fetch;

  let corpSecret: string | null = null;
  let aesKey: Buffer | null = null;
  let onMessage: ((m: NormalizedInbound) => void) | null = null;
  let server: Server | null = null;
  let tokenCache: TokenCache | null = null;
  const pending = new Map<string, PendingApproval>(); // keyed by userId

  async function ensureAccessToken(): Promise<string> {
    if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
      return tokenCache.value;
    }
    const url =
      `${apiBase}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}` +
      `&corpsecret=${encodeURIComponent(corpSecret ?? "")}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`wecom gettoken HTTP ${res.status}`);
    const data = (await res.json()) as { errcode?: number; access_token?: string; expires_in?: number };
    if (data.errcode || typeof data.access_token !== "string") {
      throw new Error(`wecom gettoken failed: errcode=${data.errcode ?? "n/a"}`);
    }
    tokenCache = {
      value: data.access_token,
      expiresAt: Date.now() + (typeof data.expires_in === "number" ? data.expires_in * 1000 : 7200_000),
    };
    return tokenCache.value;
  }

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

  async function handleGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== webhookPath) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const q = url.searchParams;
    const signature = q.get("msg_signature") ?? "";
    const timestamp = q.get("timestamp") ?? "";
    const nonce = q.get("nonce") ?? "";
    const echostr = q.get("echostr") ?? "";
    if (!verifySignature(callbackToken, timestamp, nonce, echostr, signature)) {
      res.statusCode = 403;
      res.end("bad signature");
      return;
    }
    if (!aesKey) {
      res.statusCode = 500;
      res.end("no aes key");
      return;
    }
    try {
      const { message } = decryptMessage(echostr, aesKey);
      res.statusCode = 200;
      res.end(message);
    } catch (err) {
      ctx.logger.warn(`wecom echostr decrypt failed: ${(err as Error).message}`);
      res.statusCode = 400;
      res.end("decrypt failed");
    }
  }

  async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    const q = url.searchParams;
    const signature = q.get("msg_signature") ?? "";
    const timestamp = q.get("timestamp") ?? "";
    const nonce = q.get("nonce") ?? "";
    const encrypted = extractEncrypt(raw) ?? "";
    if (!verifySignature(callbackToken, timestamp, nonce, encrypted, signature)) {
      res.statusCode = 403;
      res.end("bad signature");
      return;
    }
    if (!aesKey) {
      res.statusCode = 500;
      res.end("no aes key");
      return;
    }
    try {
      const { message } = decryptMessage(encrypted, aesKey);
      const n = normalizeWecomMessage(message);
      if (n) routeInbound(n);
    } catch (err) {
      ctx.logger.warn(`wecom callback decrypt failed: ${(err as Error).message}`);
    }
    // WeCom requires an immediate plaintext "success" or empty ack to stop retries.
    res.statusCode = 200;
    res.end("success");
  }

  async function doSend(target: ReplyTarget, content: string): Promise<MessageReceipt> {
    const accessToken = await ensureAccessToken();
    const req = buildSendRequest({ apiBase, accessToken, touser: target.chatId, agentId, content });
    const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`wecom send failed: HTTP ${res.status} ${detail}`);
    }
    const data = (await res.json()) as { errcode?: number; msgid?: string };
    if (data.errcode) {
      throw new Error(`wecom send errcode=${data.errcode}`);
    }
    return { messageId: data.msgid ?? "" };
  }

  return {
    platform: "wecom",
    capabilities: {
      threading: false,
      pairing: false,
      approvalButtons: false, // text-reply fallback (template-card buttons = later)
      streaming: "none",
    },
    async start(): Promise<void> {
      corpSecret = await ctx.getSecret(corpSecretKey);
      if (!corpSecret) throw new Error(`wecom: secret "${corpSecretKey}" missing from keyring`);
      const aesKeyRaw = await ctx.getSecret(aesKeyKey);
      if (!aesKeyRaw) throw new Error(`wecom: secret "${aesKeyKey}" missing from keyring`);
      aesKey = decodeAesKey(aesKeyRaw);
      server = createServer((req, res) => {
        if (req.method === "GET") {
          void handleGet(req, res).catch((err) => {
            ctx.logger.warn(`wecom GET failed: ${(err as Error).message}`);
            res.statusCode = 500;
            res.end();
          });
        } else if (req.method === "POST") {
          void handlePost(req, res).catch((err) => {
            ctx.logger.warn(`wecom POST failed: ${(err as Error).message}`);
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
      ctx.logger.info(`wecom callback listening on :${webhookPort}${webhookPath}`);
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
      await doSend(target, formatApprovalPrompt(req));
      return await new Promise<ApprovalDecision>((resolve) => {
        pending.set(target.chatId, {
          requestId: req.requestId,
          userId: target.chatId,
          resolve: (choice) => resolve({ requestId: req.requestId, choice }),
        });
        // Engine 300s approval timeout → Deny if no reply arrives.
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
