import { describe, expect, it } from "vitest";

import { type Logger } from "../../types.js";
import { type AdapterConfig } from "../../../config/types.js";
import { assertAdapterContract } from "../../contract.js";
import {
  buildApprovalKeyboard,
  buildEditMessageRequest,
  buildSendMessageRequest,
  createTelegramAdapter,
  formatApprovalPrompt,
  normalizeTelegramUpdate,
  parseApprovalCallback,
  type TgUpdate,
} from "../telegramAdapter.js";

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function sampleUpdate(over: Partial<TgUpdate> = {}): TgUpdate {
  return {
    update_id: 42,
    message: {
      message_id: 9001,
      date: 1700000000,
      chat: { id: 123456, type: "private" },
      from: { id: 99, first_name: "Ed", username: "ed" },
      text: "hello",
    },
    ...over,
  };
}

describe("normalizeTelegramUpdate", () => {
  it("normalizes a text message", () => {
    const n = normalizeTelegramUpdate(sampleUpdate());
    expect(n).not.toBeNull();
    expect(n).toMatchObject({
      platform: "telegram",
      chatId: "123456",
      senderId: "99",
      senderName: "Ed",
      text: "hello",
      isDirect: true,
      threadId: "9001",
    });
    expect(n?.timestamp).toBe(1700000000 * 1000);
  });

  it("falls back to username/id when first_name is absent", () => {
    const n = normalizeTelegramUpdate(
      sampleUpdate({
        message: {
          message_id: 1,
          chat: { id: 1, type: "private" },
          from: { id: 7, username: "u7" },
          text: "hi",
        },
      }),
    );
    expect(n?.senderName).toBe("u7");
  });

  it("returns null for non-text messages", () => {
    expect(
      normalizeTelegramUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 1 }, from: { id: 1 } } }),
    ).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(normalizeTelegramUpdate(null)).toBeNull();
    expect(normalizeTelegramUpdate({})).toBeNull();
    expect(normalizeTelegramUpdate({ message: { text: "x" } })).toBeNull();
  });

  it("marks group chats as not direct", () => {
    const n = normalizeTelegramUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1700000000,
        chat: { id: 1, type: "group" },
        from: { id: 2, first_name: "B" },
        text: "hi",
      },
    });
    expect(n?.isDirect).toBe(false);
  });
});

describe("buildSendMessageRequest", () => {
  const args = {
    token: "TOKEN",
    apiBaseUrl: "https://api.telegram.org",
    target: { platform: "telegram" as const, chatId: "123" },
    text: "hi",
  };

  it("targets sendMessage with chat_id + text", () => {
    const req = buildSendMessageRequest(args);
    expect(req.url).toBe("https://api.telegram.org/botTOKEN/sendMessage");
    expect(req.method).toBe("POST");
    expect(JSON.parse(req.body)).toEqual({ chat_id: "123", text: "hi" });
  });

  it("includes reply_to_message_id when target.threadId is set", () => {
    const req = buildSendMessageRequest({ ...args, target: { platform: "telegram", chatId: "123", threadId: "9001" } });
    expect(JSON.parse(req.body)).toMatchObject({ reply_to_message_id: 9001 });
  });

  it("merges extra fields (e.g. reply_markup)", () => {
    const req = buildSendMessageRequest({ ...args, extra: { reply_markup: { x: 1 } } });
    expect(JSON.parse(req.body)).toMatchObject({ reply_markup: { x: 1 } });
  });
});

describe("buildEditMessageRequest", () => {
  it("targets editMessageText with chat_id + message_id + text", () => {
    const req = buildEditMessageRequest({
      token: "TOKEN",
      apiBaseUrl: "https://api.telegram.org",
      target: { platform: "telegram", chatId: "123" },
      text: "updated",
      messageId: "9001",
    });
    expect(req.url).toBe("https://api.telegram.org/botTOKEN/editMessageText");
    expect(JSON.parse(req.body)).toEqual({ chat_id: "123", message_id: 9001, text: "updated" });
  });
});

describe("approval helpers", () => {
  it("formatApprovalPrompt includes the tool name + description and tags destructive", () => {
    const p = formatApprovalPrompt({
      requestId: "r1",
      toolName: "shell",
      toolInput: {},
      description: "run rm -rf",
      isDestructive: true,
      diffPreview: null,
    });
    expect(p).toContain("DESTRUCTIVE");
    expect(p).toContain("shell");
    expect(p).toContain("run rm -rf");
  });

  it("escapes HTML in the diff preview", () => {
    const p = formatApprovalPrompt({
      requestId: "r1",
      toolName: "t",
      toolInput: {},
      description: "d",
      isDestructive: false,
      diffPreview: "<script>x</script>",
    });
    expect(p).toContain("&lt;script&gt;");
    expect(p).not.toContain("<script>");
  });

  it("buildApprovalKeyboard encodes choice + requestId in callback_data", () => {
    const kb = buildApprovalKeyboard("req-9");
    const buttons = kb.reply_markup.inline_keyboard[0] as Array<{ text: string; callback_data: string }>;
    expect(buttons.map((b) => b.callback_data).sort()).toEqual(["allow:req-9", "deny:req-9"]);
  });

  it("parseApprovalCallback round-trips and rejects junk", () => {
    expect(parseApprovalCallback("allow:req-9")).toEqual({ choice: "allow", requestId: "req-9" });
    expect(parseApprovalCallback("deny:req-9")).toEqual({ choice: "deny", requestId: "req-9" });
    expect(parseApprovalCallback("bogus")).toBeNull();
    expect(parseApprovalCallback("maybe:req")).toBeNull();
    expect(parseApprovalCallback("allow:")).toBeNull();
  });
});

describe("createTelegramAdapter contract", () => {
  it("passes assertAdapterContract", () => {
    const cfg: AdapterConfig = { platform: "telegram", enabled: true };
    const adapter = createTelegramAdapter(cfg, { logger: noopLogger, getSecret: async () => null });
    expect(() => assertAdapterContract(adapter)).not.toThrow();
    expect(adapter.platform).toBe("telegram");
    expect(adapter.capabilities.threading).toBe(false);
    expect(adapter.capabilities.approvalButtons).toBe(true);
  });
});
