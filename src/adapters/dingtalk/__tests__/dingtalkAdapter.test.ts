import { describe, expect, it } from "vitest";

import { type Logger } from "../../types.js";
import { type AdapterConfig } from "../../../config/types.js";
import { assertAdapterContract } from "../../contract.js";
import {
  buildSessionSendRequest,
  computeDingTalkSign,
  createDingTalkAdapter,
  formatApprovalPrompt,
  normalizeDingTalkMessage,
  parseChoice,
  verifyDingTalkSign,
} from "../dingtalkAdapter.js";

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const SECRET = "SEC-robot-secret";

function outgoingBody(over: Record<string, unknown> = {}): unknown {
  return {
    msgtype: "text",
    text: { content: " hello" }, // leading space (DingTalk @bot style)
    senderId: "sender-1",
    senderNick: "Ed",
    conversationId: "cid-123",
    conversationType: "1",
    msgId: "msg-9",
    createTimestamp: "1700000000000",
    timestamp: "1609459200",
    sign: computeDingTalkSign("1609459200", SECRET),
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=x",
    sessionWebhookExpiredTime: 7200,
    ...over,
  };
}

describe("signature", () => {
  it("computeDingTalkSign is stable + round-trips via verify", () => {
    const sig = computeDingTalkSign("1609459200", SECRET);
    expect(computeDingTalkSign("1609459200", SECRET)).toBe(sig);
    expect(verifyDingTalkSign("1609459200", SECRET, sig)).toBe(true);
  });

  it("verify rejects a bad sign + a bad secret (timing-safe)", () => {
    const sig = computeDingTalkSign("1609459200", SECRET);
    expect(verifyDingTalkSign("1609459200", SECRET, "tampered==")).toBe(false);
    expect(verifyDingTalkSign("1609459200", "wrong-secret", sig)).toBe(false);
    expect(verifyDingTalkSign("9999999999", SECRET, sig)).toBe(false);
  });

  it("matches the documented HMAC-SHA256(timestamp + '\\n' + secret, secret)", () => {
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const expected = createHmac("sha256", SECRET).update(`1609459200\n${SECRET}`).digest("base64");
    expect(computeDingTalkSign("1609459200", SECRET)).toBe(expected);
  });
});

describe("normalizeDingTalkMessage", () => {
  it("normalizes a text message + strips the leading @bot space", () => {
    const n = normalizeDingTalkMessage(outgoingBody());
    expect(n).not.toBeNull();
    expect(n).toMatchObject({
      platform: "dingtalk",
      chatId: "cid-123",
      senderId: "sender-1",
      senderName: "Ed",
      text: "hello",
      isDirect: true,
      threadId: "msg-9",
    });
    expect(n?.timestamp).toBe(1700000000000);
  });

  it("marks group conversations as not direct", () => {
    const n = normalizeDingTalkMessage(outgoingBody({ conversationType: "2" }));
    expect(n?.isDirect).toBe(false);
  });

  it("skips non-text message types", () => {
    expect(normalizeDingTalkMessage(outgoingBody({ msgtype: "markdown" }))).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(normalizeDingTalkMessage(null)).toBeNull();
    expect(normalizeDingTalkMessage({})).toBeNull();
    expect(
      normalizeDingTalkMessage({ msgtype: "text", text: { content: "hi" }, senderId: "s" }),
    ).toBeNull(); // no conversationId
  });
});

describe("parseChoice (Chinese + English)", () => {
  it("recognizes 允许/同意/allow and 拒绝/否/deny", () => {
    expect(parseChoice("允许")).toBe("allow");
    expect(parseChoice("同意")).toBe("allow");
    expect(parseChoice("Allow")).toBe("allow");
    expect(parseChoice("拒绝")).toBe("deny");
    expect(parseChoice("否")).toBe("deny");
    expect(parseChoice("deny")).toBe("deny");
    expect(parseChoice("随便")).toBeNull();
  });
});

describe("buildSessionSendRequest", () => {
  it("posts to the sessionWebhook with a text payload (no auth header)", () => {
    const req = buildSessionSendRequest("https://oapi.dingtalk.com/s?session=x", "hi");
    expect(req.url).toBe("https://oapi.dingtalk.com/s?session=x");
    expect(req.method).toBe("POST");
    expect(req.headers["authorization"]).toBeUndefined();
    expect(JSON.parse(req.body)).toEqual({ msgtype: "text", text: { content: "hi" } });
  });
});

describe("formatApprovalPrompt", () => {
  it("tags destructive + asks for a reply", () => {
    const p = formatApprovalPrompt({
      requestId: "r1",
      toolName: "shell",
      toolInput: {},
      description: "rm -rf",
      isDestructive: true,
      diffPreview: null,
    });
    expect(p).toContain("危险操作");
    expect(p).toContain("允许");
    expect(p).toContain("拒绝");
  });
});

describe("createDingTalkAdapter contract", () => {
  it("passes assertAdapterContract", () => {
    const cfg: AdapterConfig = { platform: "dingtalk", enabled: true };
    const adapter = createDingTalkAdapter(cfg, { logger: noopLogger, getSecret: async () => null });
    expect(() => assertAdapterContract(adapter)).not.toThrow();
    expect(adapter.platform).toBe("dingtalk");
    expect(adapter.capabilities.approvalButtons).toBe(false);
    expect(adapter.capabilities.streaming).toBe("none");
  });
});
