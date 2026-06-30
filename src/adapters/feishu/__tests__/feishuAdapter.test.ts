import { describe, expect, it } from "vitest";

import { type Logger } from "../../types.js";
import { type AdapterConfig } from "../../../config/types.js";
import { assertAdapterContract } from "../../contract.js";
import {
  buildApprovalCard,
  buildSendRequest,
  createFeishuAdapter,
  decryptFeishuPayload,
  encryptFeishuPayload,
  extractTextContent,
  formatApprovalPrompt,
  normalizeFeishuEvent,
  parseButtonValue,
  textContent,
} from "../feishuAdapter.js";

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const ENCRYPT_KEY = "feishu-encrypt-key-secret";

describe("crypto round-trip", () => {
  it("encrypt → decrypt recovers the JSON payload (standard PKCS7)", () => {
    const json = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const enc = encryptFeishuPayload(json, ENCRYPT_KEY);
    expect(enc).not.toContain("url_verification");
    expect(decryptFeishuPayload(enc, ENCRYPT_KEY)).toBe(json);
  });

  it("decryption with the wrong key throws (PKCS7 / padding mismatch)", () => {
    const enc = encryptFeishuPayload('{"a":1}', ENCRYPT_KEY);
    expect(() => decryptFeishuPayload(enc, "wrong-key")).toThrow();
  });
});

describe("extractTextContent", () => {
  it("pulls .text out of a Feishu content JSON string", () => {
    expect(extractTextContent(JSON.stringify({ text: "你好" }))).toBe("你好");
  });
  it("returns null for non-text or malformed content", () => {
    expect(extractTextContent(JSON.stringify({ image_key: "x" }))).toBeNull();
    expect(extractTextContent("not json")).toBeNull();
  });
});

describe("normalizeFeishuEvent", () => {
  it("normalizes a p2p text message event", () => {
    const payload = {
      schema: "2.0",
      header: { event_type: "im.message.receive_v1", event_id: "e1" },
      event: {
        sender: { sender_id: { open_id: "ou_user" } },
        message: {
          message_id: "om_msg",
          chat_id: "oc_chat",
          message_type: "text",
          content: JSON.stringify({ text: "hello" }),
          chat_type: "p2p",
          create_time: "1700000000000",
        },
      },
    };
    const r = normalizeFeishuEvent(payload);
    expect(r.kind).toBe("message");
    if (r.kind !== "message") return;
    expect(r.message).toMatchObject({
      platform: "feishu",
      chatId: "oc_chat",
      senderId: "ou_user",
      text: "hello",
      isDirect: true,
      threadId: "om_msg",
    });
    expect(r.message.timestamp).toBe(1700000000000);
  });

  it("marks group chats as not direct", () => {
    const payload = {
      header: { event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_id: { open_id: "ou_u" } },
        message: { chat_id: "oc_g", content: JSON.stringify({ text: "hi" }), chat_type: "group" },
      },
    };
    const r = normalizeFeishuEvent(payload);
    expect(r.kind).toBe("message");
    if (r.kind === "message") expect(r.message.isDirect).toBe(false);
  });

  it("handles url_verification challenge events", () => {
    const r = normalizeFeishuEvent({ type: "url_verification", challenge: "CH-1" });
    expect(r).toEqual({ kind: "challenge", challenge: "CH-1" });
  });

  it("extracts card button clicks", () => {
    const payload = {
      header: { event_type: "card.action.trigger" },
      event: {
        message: { chat_id: "oc_c" },
        action: { value: { choice: "allow", requestId: "r9" } },
      },
    };
    const r = normalizeFeishuEvent(payload);
    expect(r.kind).toBe("button");
    if (r.kind === "button") {
      expect(r.value).toEqual({ choice: "allow", requestId: "r9" });
      expect(r.chatId).toBe("oc_c");
    }
  });

  it("ignores unknown event types", () => {
    expect(normalizeFeishuEvent({ header: { event_type: "some.other.event" } }).kind).toBe("ignore");
    expect(normalizeFeishuEvent(null).kind).toBe("ignore");
  });
});

describe("outbound builders", () => {
  it("buildSendRequest targets the messages endpoint with Bearer auth", () => {
    const req = buildSendRequest({
      apiBase: "https://open.feishu.cn",
      tenantAccessToken: "TOK",
      receiveId: "ou_user",
      receiveIdType: "open_id",
      msgType: "text",
      contentJson: textContent("hi"),
    });
    expect(req.url).toBe("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id");
    expect(req.headers.authorization).toBe("Bearer TOK");
    expect(JSON.parse(req.body)).toEqual({
      receive_id: "ou_user",
      msg_type: "text",
      content: JSON.stringify({ text: "hi" }),
    });
  });

  it("buildApprovalCard carries the choice + requestId in button values", () => {
    const cardJson = buildApprovalCard("req-9", "prompt");
    const card = JSON.parse(cardJson) as { elements: Array<{ tag: string; actions?: Array<{ value: Record<string, string> }> }> };
    const action = card.elements.find((e) => e.tag === "action");
    const values = action?.actions?.map((b) => b.value) ?? [];
    expect(values).toContainEqual({ choice: "allow", requestId: "req-9" });
    expect(values).toContainEqual({ choice: "deny", requestId: "req-9" });
  });

  it("parseButtonValue round-trips and rejects junk", () => {
    expect(parseButtonValue({ choice: "allow", requestId: "r9" })).toEqual({ choice: "allow", requestId: "r9" });
    expect(parseButtonValue({ choice: "deny", requestId: "r9" })).toEqual({ choice: "deny", requestId: "r9" });
    expect(parseButtonValue({ choice: "maybe", requestId: "r9" })).toBeNull();
    expect(parseButtonValue({ choice: "allow", requestId: "" })).toBeNull();
  });
});

describe("formatApprovalPrompt", () => {
  it("tags destructive + names the tool", () => {
    const p = formatApprovalPrompt({
      requestId: "r1",
      toolName: "shell",
      toolInput: {},
      description: "rm -rf",
      isDestructive: true,
      diffPreview: null,
    });
    expect(p).toContain("危险操作");
    expect(p).toContain("shell");
  });
});

describe("createFeishuAdapter contract", () => {
  it("passes assertAdapterContract", () => {
    const cfg: AdapterConfig = { platform: "feishu", enabled: true, options: { appId: "cli_x" } };
    const adapter = createFeishuAdapter(cfg, { logger: noopLogger, getSecret: async () => null });
    expect(() => assertAdapterContract(adapter)).not.toThrow();
    expect(adapter.platform).toBe("feishu");
    expect(adapter.capabilities.approvalButtons).toBe(true);
    expect(adapter.capabilities.streaming).toBe("partial");
  });

  it("fails fast when appId is missing", () => {
    expect(() =>
      createFeishuAdapter(
        { platform: "feishu", enabled: true },
        { logger: noopLogger, getSecret: async () => null },
      ),
    ).toThrow(/appId/);
  });
});
