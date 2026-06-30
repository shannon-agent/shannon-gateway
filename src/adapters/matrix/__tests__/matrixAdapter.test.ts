import { describe, expect, it } from "vitest";

import { type Logger } from "../../types.js";
import { type AdapterConfig } from "../../../config/types.js";
import { assertAdapterContract } from "../../contract.js";
import {
  buildEditContent,
  buildMessageContent,
  buildSendEventRequest,
  createMatrixAdapter,
  extractMessagesFromSync,
  formatApprovalPrompt,
  normalizeMatrixEvent,
  parseChoice,
} from "../matrixAdapter.js";

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function textEvent(body: string, sender = "@alice:server.org", eventId = "$evt1"): unknown {
  return {
    type: "m.room.message",
    content: { msgtype: "m.text", body },
    sender,
    event_id: eventId,
    origin_server_ts: 1700000000000,
  };
}

describe("normalizeMatrixEvent", () => {
  it("normalizes a text message event", () => {
    const n = normalizeMatrixEvent(textEvent("hello") as never, "!room:server.org", null);
    expect(n).not.toBeNull();
    expect(n).toMatchObject({
      platform: "matrix",
      chatId: "!room:server.org",
      senderId: "@alice:server.org",
      senderName: "@alice:server.org",
      text: "hello",
      threadId: "$evt1",
    });
    expect(n?.timestamp).toBe(1700000000000);
  });

  it("skips the bot's own echoes", () => {
    const n = normalizeMatrixEvent(
      textEvent("echo", "@bot:server.org") as never,
      "!room:server.org",
      "@bot:server.org",
    );
    expect(n).toBeNull();
  });

  it("skips non-text and non-message events", () => {
    expect(
      normalizeMatrixEvent({ type: "m.typing" } as never, "!r", null),
    ).toBeNull();
    expect(
      normalizeMatrixEvent(
        { type: "m.room.message", content: { msgtype: "m.emote", body: "x" } } as never,
        "!r",
        null,
      ),
    ).toBeNull();
    expect(
      normalizeMatrixEvent(
        { type: "m.room.message", content: { msgtype: "m.text", body: "" } } as never,
        "!r",
        null,
      ),
    ).toBeNull();
  });
});

describe("extractMessagesFromSync", () => {
  it("walks joined rooms and returns next_batch", () => {
    const sync = {
      next_batch: "BATCH2",
      rooms: {
        join: {
          "!a:server.org": { timeline: { events: [textEvent("hi-a")] } },
          "!b:server.org": { timeline: { events: [textEvent("hi-b", "@bob:s.o", "$e2")] } },
        },
      },
    };
    const { messages, nextBatch } = extractMessagesFromSync(sync, null);
    expect(nextBatch).toBe("BATCH2");
    expect(messages.map((m) => m.chatId).sort()).toEqual(["!a:server.org", "!b:server.org"]);
    expect(messages.map((m) => m.text).sort()).toEqual(["hi-a", "hi-b"]);
  });

  it("skips own echoes across rooms", () => {
    const sync = {
      next_batch: "b",
      rooms: { join: { "!a:server.org": { timeline: { events: [textEvent("mine", "@bot:s")] } } } },
    };
    expect(extractMessagesFromSync(sync, "@bot:s").messages).toHaveLength(0);
  });

  it("returns empty for malformed sync", () => {
    expect(extractMessagesFromSync(null, null).messages).toEqual([]);
    expect(extractMessagesFromSync({}, null).messages).toEqual([]);
  });
});

describe("buildMessageContent", () => {
  it("builds a plain text content without reply", () => {
    expect(buildMessageContent("hi")).toEqual({ msgtype: "m.text", body: "hi" });
  });

  it("adds m.in_reply_to when replying", () => {
    const c = buildMessageContent("hi", "$orig");
    expect(c["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$orig" } });
  });
});

describe("buildEditContent", () => {
  it("builds an m.replace relation pointing at the original event", () => {
    const c = buildEditContent("$orig", "updated");
    expect(c.body).toBe("* updated");
    expect(c["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: "$orig" });
    expect(c["m.new_content"]).toEqual({ msgtype: "m.text", body: "updated" });
  });
});

describe("buildSendEventRequest", () => {
  it("targets the send-event PUT with Bearer auth + txn idempotency", () => {
    const req = buildSendEventRequest({
      baseUrl: "https://matrix.org",
      accessToken: "TOK",
      roomId: "!room:server.org",
      txnId: "tx1",
      content: buildMessageContent("hi"),
    });
    expect(req.method).toBe("PUT");
    // `!` is a sub-delim and is NOT encoded by encodeURIComponent; only `:`.
    expect(req.url).toBe(
      "https://matrix.org/_matrix/client/v3/rooms/!room%3Aserver.org/send/m.room.message/tx1",
    );
    expect(req.headers.authorization).toBe("Bearer TOK");
    expect(JSON.parse(req.body)).toEqual({ msgtype: "m.text", body: "hi" });
  });
});

describe("approval helpers", () => {
  it("formatApprovalPrompt tags destructive + asks for a reply", () => {
    const p = formatApprovalPrompt({
      requestId: "r1",
      toolName: "shell",
      toolInput: {},
      description: "rm -rf",
      isDestructive: true,
      diffPreview: null,
    });
    expect(p).toContain("DESTRUCTIVE");
    expect(p).toContain("shell");
    expect(p).toContain('"allow" or "deny"');
  });

  it("parseChoice recognizes allow/deny synonyms", () => {
    expect(parseChoice("allow")).toBe("allow");
    expect(parseChoice("  YES ")).toBe("allow");
    expect(parseChoice("Deny")).toBe("deny");
    expect(parseChoice("n")).toBe("deny");
    expect(parseChoice("maybe")).toBeNull();
  });
});

describe("createMatrixAdapter contract", () => {
  it("passes assertAdapterContract", () => {
    const cfg: AdapterConfig = {
      platform: "matrix",
      enabled: true,
      options: { baseUrl: "https://matrix.org" },
    };
    const adapter = createMatrixAdapter(cfg, {
      logger: noopLogger,
      getSecret: async () => null,
    });
    expect(() => assertAdapterContract(adapter)).not.toThrow();
    expect(adapter.platform).toBe("matrix");
    expect(adapter.capabilities.threading).toBe(false);
    expect(adapter.capabilities.approvalButtons).toBe(false); // text-reply flow
    expect(adapter.capabilities.streaming).toBe("partial");
  });
});
