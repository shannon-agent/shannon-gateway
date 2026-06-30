import { describe, expect, it } from "vitest";

import { type Logger } from "../../types.js";
import { type AdapterConfig } from "../../../config/types.js";
import { assertAdapterContract } from "../../contract.js";
import {
  buildApprovalComponents,
  buildCreateMessageRequest,
  buildEditMessageRequest,
  createDiscordAdapter,
  formatApprovalPrompt,
  normalizeDiscordMessage,
  parseApprovalButton,
  type DcMessage,
} from "../discordAdapter.js";

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function sampleMessage(over: Partial<DcMessage> = {}): DcMessage {
  return {
    id: "100",
    channel_id: "456",
    content: "hello",
    author: { id: "789", username: "ed", global_name: "Ed" },
    guild_id: null,
    timestamp: "2024-01-01T00:00:00.000+00:00",
    ...over,
  };
}

describe("normalizeDiscordMessage", () => {
  it("normalizes a DM text message", () => {
    const n = normalizeDiscordMessage(sampleMessage());
    expect(n).not.toBeNull();
    expect(n).toMatchObject({
      platform: "discord",
      chatId: "456",
      senderId: "789",
      senderName: "Ed",
      text: "hello",
      isDirect: true,
      threadId: "100",
    });
    expect(n?.timestamp).toBe(Date.parse("2024-01-01T00:00:00.000+00:00"));
  });

  it("falls back to username when global_name is absent", () => {
    const n = normalizeDiscordMessage(
      sampleMessage({ author: { id: "1", username: "rawname", global_name: null } }),
    );
    expect(n?.senderName).toBe("rawname");
  });

  it("marks guild messages as not direct", () => {
    const n = normalizeDiscordMessage(sampleMessage({ guild_id: "999" }));
    expect(n?.isDirect).toBe(false);
  });

  it("ignores messages from bots", () => {
    const n = normalizeDiscordMessage(
      sampleMessage({ author: { id: "1", username: "bot", bot: true } }),
    );
    expect(n).toBeNull();
  });

  it("ignores messages without text content", () => {
    expect(normalizeDiscordMessage({ ...sampleMessage(), content: "" })).toBeNull();
    expect(normalizeDiscordMessage({ ...sampleMessage(), content: undefined })).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(normalizeDiscordMessage(null)).toBeNull();
    expect(normalizeDiscordMessage({})).toBeNull();
    expect(normalizeDiscordMessage({ content: "x" })).toBeNull();
    expect(normalizeDiscordMessage({ id: "1", channel_id: "c" })).toBeNull();
  });

  it("uses Date.now() when timestamp is missing", () => {
    const before = Date.now();
    const n = normalizeDiscordMessage({ ...sampleMessage(), timestamp: undefined });
    const after = Date.now();
    expect(n?.timestamp).toBeGreaterThanOrEqual(before);
    expect(n?.timestamp).toBeLessThanOrEqual(after);
  });
});

describe("buildCreateMessageRequest", () => {
  const args = {
    token: "BOT_TOKEN",
    apiBaseUrl: "https://discord.com/api/v10",
    target: { platform: "discord" as const, chatId: "456" },
    content: "hi",
  };

  it("targets the channel messages endpoint with Bot auth", () => {
    const req = buildCreateMessageRequest(args);
    expect(req.url).toBe("https://discord.com/api/v10/channels/456/messages");
    expect(req.method).toBe("POST");
    expect(req.headers.authorization).toBe("Bot BOT_TOKEN");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(req.body)).toEqual({ content: "hi" });
  });

  it("includes message_reference when target.threadId is set", () => {
    const req = buildCreateMessageRequest({
      ...args,
      target: { platform: "discord", chatId: "456", threadId: "100" },
    });
    expect(JSON.parse(req.body)).toMatchObject({ message_reference: { message_id: "100" } });
  });

  it("merges components (approval buttons)", () => {
    const req = buildCreateMessageRequest({ ...args, components: [{ type: 1 }] });
    expect(JSON.parse(req.body)).toMatchObject({ components: [{ type: 1 }] });
  });
});

describe("buildEditMessageRequest", () => {
  it("PATCHes the channel message with content + Bot auth", () => {
    const req = buildEditMessageRequest({
      token: "BOT_TOKEN",
      apiBaseUrl: "https://discord.com/api/v10",
      channelId: "456",
      messageId: "789",
      content: "edited",
    });
    expect(req.method).toBe("PATCH");
    expect(req.url).toBe("https://discord.com/api/v10/channels/456/messages/789");
    expect(req.headers.authorization).toBe("Bot BOT_TOKEN");
    expect(JSON.parse(req.body)).toEqual({ content: "edited" });
  });
});

describe("approval helpers", () => {
  it("formatApprovalPrompt tags destructive + wraps diff in a code block", () => {
    const p = formatApprovalPrompt({
      requestId: "r1",
      toolName: "shell",
      toolInput: {},
      description: "run rm -rf",
      isDestructive: true,
      diffPreview: "- old\n+ new",
    });
    expect(p).toContain("DESTRUCTIVE");
    expect(p).toContain("**shell**");
    expect(p).toContain("run rm -rf");
    expect(p).toContain("```diff");
    expect(p).toContain("- old");
  });

  it("formatApprovalPrompt omits the diff block when none", () => {
    const p = formatApprovalPrompt({
      requestId: "r1",
      toolName: "t",
      toolInput: {},
      description: "d",
      isDestructive: false,
      diffPreview: null,
    });
    expect(p).not.toContain("```");
  });

  it("buildApprovalComponents encodes choice + requestId in custom_id", () => {
    const row = buildApprovalComponents("req-9").components[0] as {
      components: Array<{ custom_id: string; style: number }>;
    };
    const ids = row.components.map((b) => b.custom_id).sort();
    expect(ids).toEqual(["allow:req-9", "deny:req-9"]);
    // style 3 = SUCCESS (allow), style 4 = DANGER (deny)
    const allow = row.components.find((b) => b.custom_id.startsWith("allow"));
    expect(allow?.style).toBe(3);
  });

  it("parseApprovalButton round-trips and rejects junk", () => {
    expect(parseApprovalButton("allow:req-9")).toEqual({ choice: "allow", requestId: "req-9" });
    expect(parseApprovalButton("deny:req-9")).toEqual({ choice: "deny", requestId: "req-9" });
    expect(parseApprovalButton("bogus")).toBeNull();
    expect(parseApprovalButton("maybe:req")).toBeNull();
    expect(parseApprovalButton("allow:")).toBeNull();
  });
});

describe("createDiscordAdapter contract", () => {
  it("passes assertAdapterContract", () => {
    const cfg: AdapterConfig = { platform: "discord", enabled: true };
    const adapter = createDiscordAdapter(cfg, { logger: noopLogger, getSecret: async () => null });
    expect(() => assertAdapterContract(adapter)).not.toThrow();
    expect(adapter.platform).toBe("discord");
    expect(adapter.capabilities.threading).toBe(false);
    expect(adapter.capabilities.approvalButtons).toBe(true);
    expect(adapter.capabilities.streaming).toBe("partial");
    expect(adapter.capabilities.editWindowMs).toBe(60 * 60 * 1000);
  });
});
