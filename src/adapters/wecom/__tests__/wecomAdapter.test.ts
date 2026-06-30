import { describe, expect, it } from "vitest";

import { type Logger } from "../../types.js";
import { type AdapterConfig } from "../../../config/types.js";
import { assertAdapterContract } from "../../contract.js";
import {
  buildSendRequest,
  computeSignature,
  createWeComAdapter,
  decodeAesKey,
  decryptMessage,
  encryptMessage,
  extractEncrypt,
  formatApprovalPrompt,
  normalizeWecomMessage,
  parseChoice,
  verifySignature,
  xmlField,
} from "../wecomAdapter.js";

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

// A real 32-byte AES key derived from a 43-char base64 EncodingAESKey.
const ENCODING_AES_KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const AES_KEY = decodeAesKey(ENCODING_AES_KEY);
const APP_ID = "wx_corp_id";

describe("crypto round-trip", () => {
  it("decodes the 43-char EncodingAESKey to a 32-byte key", () => {
    expect(AES_KEY.length).toBe(32);
  });

  it("encrypt → decrypt recovers message + appId", () => {
    const plain = "<xml><Content><![CDATA[hello]]></Content></xml>";
    const ciphertext = encryptMessage(plain, APP_ID, AES_KEY);
    expect(ciphertext).not.toContain(plain);
    const recovered = decryptMessage(ciphertext, AES_KEY);
    expect(recovered.message).toBe(plain);
    expect(recovered.appId).toBe(APP_ID);
  });

  it("handles unicode + multi-byte correctly", () => {
    const plain = "你好，世界 🌍";
    const recovered = decryptMessage(encryptMessage(plain, APP_ID, AES_KEY), AES_KEY);
    expect(recovered.message).toBe(plain);
  });
});

describe("signatures", () => {
  const token = "cbToken";
  const ts = "1609459200";
  const nonce = "n1";
  const encrypted = "BASE64CIPHER";

  it("computeSignature is stable + matches verify", () => {
    const sig = computeSignature(token, ts, nonce, encrypted);
    // Deterministic.
    expect(computeSignature(token, ts, nonce, encrypted)).toBe(sig);
    expect(verifySignature(token, ts, nonce, encrypted, sig)).toBe(true);
  });

  it("verify rejects tampered components", () => {
    const sig = computeSignature(token, ts, nonce, encrypted);
    expect(verifySignature("wrong", ts, nonce, encrypted, sig)).toBe(false);
    expect(verifySignature(token, ts, nonce, "tampered", sig)).toBe(false);
  });

  // Sanity-check a known SHA1(sort) value.
  it("computeSignature matches the documented algorithm", () => {
    // parts sorted: [encrypted, nonce, token, ts]
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const expected = createHash("sha1")
      .update([encrypted, nonce, token, ts].sort().join(""))
      .digest("hex");
    expect(computeSignature(token, ts, nonce, encrypted)).toBe(expected);
  });
});

describe("xml helpers", () => {
  it("xmlField reads CDATA + raw values", () => {
    expect(xmlField("<X><![CDATA[hi]]></X>", "X")).toBe("hi");
    expect(xmlField("<X>raw</X>", "X")).toBe("raw");
    expect(xmlField("<X>  spaced  </X>", "X")).toBe("spaced");
    expect(xmlField("<Y>1</Y>", "X")).toBeUndefined();
  });

  it("extractEncrypt pulls the Encrypt envelope", () => {
    const xml = "<xml><ToUserName><![CDATA[c]]></ToUserName><Encrypt><![CDATA[ENC]]></Encrypt></xml>";
    expect(extractEncrypt(xml)).toBe("ENC");
  });
});

describe("normalizeWecomMessage", () => {
  const xml = (content: string, from = "u1", msgId = "100"): string =>
    `<xml><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content><FromUserName><![CDATA[${from}]]></FromUserName><CreateTime>1700000000</CreateTime><MsgId>${msgId}</MsgId></xml>`;

  it("normalizes a decrypted text message", () => {
    const n = normalizeWecomMessage(xml("你好"));
    expect(n).not.toBeNull();
    expect(n).toMatchObject({
      platform: "wecom",
      chatId: "u1",
      senderId: "u1",
      text: "你好",
      isDirect: true,
      threadId: "100",
    });
    expect(n?.timestamp).toBe(1700000000 * 1000);
  });

  it("skips non-text message types", () => {
    const eventXml = "<xml><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event></xml>";
    expect(normalizeWecomMessage(eventXml)).toBeNull();
  });

  it("returns null when required fields are absent", () => {
    expect(normalizeWecomMessage("<xml><MsgType><![CDATA[text]]></MsgType></xml>")).toBeNull();
  });
});

describe("parseChoice (Chinese + English)", () => {
  it("recognizes 允许/同意/allow", () => {
    expect(parseChoice("允许")).toBe("allow");
    expect(parseChoice("同意")).toBe("allow");
    expect(parseChoice("Allow")).toBe("allow");
  });
  it("recognizes 拒绝/否/deny", () => {
    expect(parseChoice("拒绝")).toBe("deny");
    expect(parseChoice("否")).toBe("deny");
    expect(parseChoice("deny")).toBe("deny");
  });
  it("returns null for non-matching text", () => {
    expect(parseChoice("也许")).toBeNull();
  });
});

describe("buildSendRequest", () => {
  it("targets message/send with access_token + text payload", () => {
    const req = buildSendRequest({
      apiBase: "https://qyapi.weixin.qq.com",
      accessToken: "TOK",
      touser: "u1",
      agentId: "1000002",
      content: "hi",
    });
    expect(req.url).toBe("https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=TOK");
    expect(JSON.parse(req.body)).toEqual({
      touser: "u1",
      msgtype: "text",
      agentid: "1000002",
      text: { content: "hi" },
    });
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

describe("createWeComAdapter contract", () => {
  function makeCfg(options: Partial<Record<string, unknown>> = {}): AdapterConfig {
    return {
      platform: "wecom",
      enabled: true,
      options: { corpId: "CORP", agentId: "1000002", callbackToken: "tok", ...options },
    };
  }

  it("passes assertAdapterContract", () => {
    const adapter = createWeComAdapter(makeCfg(), { logger: noopLogger, getSecret: async () => null });
    expect(() => assertAdapterContract(adapter)).not.toThrow();
    expect(adapter.platform).toBe("wecom");
    expect(adapter.capabilities.approvalButtons).toBe(false);
    expect(adapter.capabilities.streaming).toBe("none");
  });

  it("fails fast when corpId is missing", () => {
    expect(() =>
      createWeComAdapter(makeCfg({ corpId: undefined }), {
        logger: noopLogger,
        getSecret: async () => null,
      }),
    ).toThrow(/corpId/);
  });

  it("fails fast when callbackToken is missing", () => {
    expect(() =>
      createWeComAdapter(makeCfg({ callbackToken: undefined }), {
        logger: noopLogger,
        getSecret: async () => null,
      }),
    ).toThrow(/callbackToken/);
  });
});
