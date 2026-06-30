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
 * DingTalk (钉钉) adapter — **custom-robot outgoing webhook** model.
 *
 * DingTalk exposes two bot models: the enterprise app (event subscription,
 * AES-encrypted — byte-identical to WeCom's crypto) and the **custom-robot
 * outgoing webhook**. This adapter implements the latter: it's the most common
 * "group assistant" pattern and avoids re-duplicating the WeChat-style AES
 * layer (WeCom owns that; a shared lib can dedupe later if the enterprise-app
 * flavor is ever added).
 *
 * Inbound: when someone @mentions the robot, DingTalk POSTs a JSON body to the
 * configured outgoing URL. The body carries a `timestamp` + `sign`; the sign
 * is `base64( HMAC-SHA256( timestamp + "\n" + secret, secret ) )`. The POST
 * also includes a `sessionWebhook` — a temporary reply URL valid ~2h — which
 * is the only way the bot can answer without a separate access-token flow.
 *
 * Outbound: `POST <sessionWebhook>` with a text payload (no auth header; the
 * session URL is itself the credential). The adapter remembers the latest
 * `sessionWebhook` per conversation and refreshes it on each inbound.
 *
 * Sessions: a DingTalk conversation is the session unit
 * (`chatId = conversationId`, `threading = false`). `isDirect` comes from
 * `conversationType` ("1" = 1:1, "2" = group).
 *
 * Approval: the custom-robot button callback needs a separately-configured
 * endpoint, so `approvalButtons = false` here and approval uses the text-reply
 * fallback (post the prompt, intercept the next `allow`/`deny`). The 300s
 * engine timeout fits inside the 2h session window. Engine timeout → Deny.
 *
 * Docs: https://open.dingtalk.com/document/robots/custom-robot-access
 *       (outgoing webhook + signature).
 */

// ── signature (pure, round-trip tested) ─────────────────────────────────

/** Compute the DingTalk outgoing-webhook sign for (timestamp, secret). */
export function computeDingTalkSign(timestamp: string, secret: string): string {
  const stringToSign = `${timestamp}\n${secret}`;
  return createHmac("sha256", secret).update(stringToSign).digest("base64");
}

/** Timing-safe verification of an incoming `sign`. */
export function verifyDingTalkSign(
  timestamp: string,
  secret: string,
  providedSign: string,
): boolean {
  const expected = Buffer.from(computeDingTalkSign(timestamp, secret));
  const actual = Buffer.from(providedSign);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// ── inbound normalization (pure) ────────────────────────────────────────

interface DtOutgoingBody {
  msgtype?: string;
  text?: { content?: string };
  senderId?: string;
  senderNick?: string;
  conversationId?: string;
  conversationType?: string; // "1" | "2"
  msgId?: string;
  createTimestamp?: string;
  timestamp?: string;
  sign?: string;
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number;
}

/** Normalize a DingTalk outgoing-webhook body → NormalizedInbound, or null. */
export function normalizeDingTalkMessage(body: unknown): NormalizedInbound | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as DtOutgoingBody;
  if (b.msgtype !== "text") return null;
  const rawContent = b.text?.content;
  if (typeof rawContent !== "string" || rawContent.trim().length === 0) return null;
  if (!b.conversationId || !b.senderId) return null;
  const ts = b.createTimestamp ? Number(b.createTimestamp) : Date.now();
  return {
    platform: "dingtalk",
    chatId: b.conversationId,
    senderId: b.senderId,
    senderName: b.senderNick ?? b.senderId,
    // DingTalk prefixes @bot mentions with a leading space; trim it.
    text: rawContent.trim(),
    timestamp: Number.isFinite(ts) ? ts : Date.now(),
    threadId: b.msgId,
    isDirect: b.conversationType === "1",
    raw: body,
  };
}

/** Recognize a free-text allow/deny reply (buttonless approval fallback). */
export function parseChoice(text: string): "allow" | "deny" | null {
  const t = text.trim().toLowerCase();
  if (["allow", "yes", "y", "同意", "允许", "✅"].includes(t)) return "allow";
  if (["deny", "no", "n", "拒绝", "否", "❌"].includes(t)) return "deny";
  return null;
}

// ── outbound request builder (pure) ─────────────────────────────────────

export interface DtRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/** Build a text reply to a sessionWebhook. No auth header — the URL is the credential. */
export function buildSessionSendRequest(sessionWebhook: string, content: string): DtRequest {
  return {
    url: sessionWebhook,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msgtype: "text", text: { content } }),
  };
}

export function formatApprovalPrompt(req: ApprovalReq): string {
  const tag = req.isDestructive ? "⚠️ 危险操作" : "工具";
  const diff = req.diffPreview ? `\n\n${req.diffPreview}` : "";
  return `🔐 审批 (${tag}): ${req.toolName}\n${req.description}${diff}\n— 回复「允许」或「拒绝」`;
}

// ── adapter ────────────────────────────────────────────────────────────

export interface DingTalkAdapterOptions {
  /** Keyring key for the robot secret (加签). Default `dingtalk/robot-secret`. */
  robotSecretKey?: string;
  /** Local callback port. Default 9874. */
  webhookPort?: number;
  /** Callback path. Default `/dingtalk`. */
  webhookPath?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** When true, skip sign verification (dev only). Default false. */
  skipSignVerify?: boolean;
}

interface SessionWebhook {
  url: string;
  expiresAt: number;
}

interface PendingApproval {
  requestId: string;
  resolve: (choice: "allow" | "deny") => void;
}

export function createDingTalkAdapter(cfg: AdapterConfig, ctx: AdapterContext): ChannelAdapter {
  const o = (cfg.options ?? {}) as unknown as DingTalkAdapterOptions;
  const robotSecretKey = o.robotSecretKey ?? "dingtalk/robot-secret";
  const webhookPort = o.webhookPort ?? 9874;
  const webhookPath = o.webhookPath ?? "/dingtalk";
  const fetchImpl = o.fetchImpl ?? fetch;
  const skipSignVerify = o.skipSignVerify === true;

  let secret: string | null = null;
  let onMessage: ((m: NormalizedInbound) => void) | null = null;
  let server: Server | null = null;
  const sessions = new Map<string, SessionWebhook>();
  const pending = new Map<string, PendingApproval>(); // keyed by conversationId

  function rememberSession(body: DtOutgoingBody): void {
    if (typeof body.sessionWebhook !== "string" || body.sessionWebhook.length === 0) return;
    const expiresIn = (body.sessionWebhookExpiredTime ?? 0) * 1000;
    sessions.set(body.conversationId ?? "", {
      url: body.sessionWebhook,
      expiresAt: Date.now() + (expiresIn > 0 ? expiresIn : 2 * 60 * 60 * 1000),
    });
  }

  function lookupSession(chatId: string): string | null {
    const s = sessions.get(chatId);
    if (!s) return null;
    if (s.expiresAt <= Date.now()) {
      sessions.delete(chatId);
      return null;
    }
    return s.url;
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
    const body = parsed as DtOutgoingBody;
    if (!skipSignVerify && secret) {
      const ts = typeof body.timestamp === "string" ? body.timestamp : "";
      const sign = typeof body.sign === "string" ? body.sign : "";
      if (!ts || !sign || !verifyDingTalkSign(ts, secret, sign)) {
        res.statusCode = 401;
        res.end("bad sign");
        return;
      }
    }
    rememberSession(body);
    const n = normalizeDingTalkMessage(parsed);
    if (n) routeInbound(n);
    res.statusCode = 200;
    res.end();
  }

  async function doSend(target: ReplyTarget, content: string): Promise<MessageReceipt> {
    const sessionWebhook = lookupSession(target.chatId);
    if (!sessionWebhook) {
      throw new Error(
        `dingtalk: no active sessionWebhook for "${target.chatId}" (reply within ~2h of the last inbound)`,
      );
    }
    const req = buildSessionSendRequest(sessionWebhook, content);
    const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`dingtalk send failed: HTTP ${res.status} ${detail}`);
    }
    const data = (await res.json()) as { errcode?: number; message?: string; messageId?: string };
    if (data.errcode) {
      throw new Error(`dingtalk send errcode=${data.errcode}: ${data.message ?? ""}`);
    }
    return { messageId: data.messageId ?? "" };
  }

  return {
    platform: "dingtalk",
    capabilities: {
      threading: false,
      pairing: false,
      approvalButtons: false, // text-reply fallback (button callback = later)
      streaming: "none",
    },
    async start(): Promise<void> {
      secret = await ctx.getSecret(robotSecretKey);
      if (!secret) throw new Error(`dingtalk: secret "${robotSecretKey}" missing from keyring`);
      server = createServer((req, res) => {
        if (req.method === "POST") {
          void handlePost(req, res).catch((err) => {
            ctx.logger.warn(`dingtalk POST failed: ${(err as Error).message}`);
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
      ctx.logger.info(`dingtalk callback listening on :${webhookPort}${webhookPath}`);
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
          resolve: (choice) => resolve({ requestId: req.requestId, choice }),
        });
        // Engine 300s approval timeout fits in the 2h session window → Deny.
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
