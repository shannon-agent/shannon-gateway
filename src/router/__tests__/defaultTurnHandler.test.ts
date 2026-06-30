import { describe, expect, it, vi } from "vitest";

import {
  type ChannelAdapter,
  type Logger,
  type NormalizedInbound,
  type Platform,
  type ReplyTarget,
} from "../../adapters/types.js";
import { AdapterRegistry } from "../../adapters/registry.js";
import { type EngineEvent } from "../../engine/types.js";
import { type EngineWsClient } from "../../engine/wsClient.js";
import { SessionRouter } from "../router.js";
import { createDefaultTurnHandler } from "../defaultTurnHandler.js";
import { type TurnContext } from "../types.js";

interface RecordingAdapter extends ChannelAdapter {
  sends: Array<{ target: ReplyTarget; text: string }>;
}

function recordingAdapter(platform: Platform = "slack"): RecordingAdapter {
  const sends: RecordingAdapter["sends"] = [];
  return {
    platform,
    capabilities: {
      threading: true,
      pairing: false,
      approvalButtons: false,
      streaming: "none",
    },
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    send: async (target, text) => {
      sends.push({ target, text });
      return { messageId: `m${sends.length}` };
    },
    requestApproval: async (_t, req) => ({
      requestId: req.requestId,
      choice: "allow" as const,
    }),
    resolveSessionConversation: (id) => ({ baseChatId: id }),
    sends,
  };
}

function mockClient(events: EngineEvent[]): EngineWsClient {
  return {
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    runQuery: vi.fn(async function* (): AsyncGenerator<EngineEvent> {
      for (const e of events) yield e;
    }),
  } as unknown as EngineWsClient;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function ctxFor(
  adapter: RecordingAdapter,
  client: EngineWsClient,
  opts: { text?: string; threadId?: string } = {},
): TurnContext {
  const inbound: NormalizedInbound = {
    platform: adapter.platform,
    chatId: "C1",
    threadId: opts.threadId,
    senderId: "U1",
    senderName: "ed",
    text: opts.text ?? "hello",
    timestamp: 0,
  };
  return {
    inbound,
    client,
    adapter,
    replyTarget: {
      platform: adapter.platform,
      chatId: "C1",
      threadId: opts.threadId,
    },
    logger: noopLogger,
  };
}

describe("createDefaultTurnHandler", () => {
  it("accumulates text chunks and sends one reply on completed", async () => {
    const handler = createDefaultTurnHandler();
    const adapter = recordingAdapter();
    await handler.handle(
      ctxFor(adapter, mockClient([
        { type: "text", content: "Hello" },
        { type: "text", content: ", world" },
        { type: "usage", input_tokens: 1, output_tokens: 2, cost_usd: 0 },
        { type: "completed", model: "gpt-test" },
      ])),
    );
    expect(adapter.sends).toEqual([
      { target: expect.objectContaining({ chatId: "C1" }), text: "Hello, world" },
    ]);
  });

  it("preserves threadId on the outbound reply target (F4)", async () => {
    const handler = createDefaultTurnHandler();
    const adapter = recordingAdapter();
    await handler.handle(
      ctxFor(
        adapter,
        mockClient([
          { type: "text", content: "in thread" },
          { type: "completed", model: "gpt-test" },
        ]),
        { threadId: "T42" },
      ),
    );
    expect(adapter.sends[0]?.target.threadId).toBe("T42");
  });

  it("sends a failure-prefixed message on failed", async () => {
    const handler = createDefaultTurnHandler({ failurePrefix: "err: " });
    const adapter = recordingAdapter();
    await handler.handle(
      ctxFor(adapter, mockClient([{ type: "failed", error: "boom" }])),
    );
    expect(adapter.sends[0]?.text).toBe("err: boom");
  });

  it("does not send an empty reply", async () => {
    const handler = createDefaultTurnHandler();
    const adapter = recordingAdapter();
    await handler.handle(
      ctxFor(adapter, mockClient([{ type: "completed", model: "gpt-test" }])),
    );
    expect(adapter.sends).toHaveLength(0);
  });

  it("forwards partial text on cancelled, stays quiet if empty", async () => {
    const handler = createDefaultTurnHandler();

    const partial = recordingAdapter();
    await handler.handle(
      ctxFor(partial, mockClient([
        { type: "text", content: "partial" },
        { type: "cancelled" },
      ])),
    );
    expect(partial.sends[0]?.text).toBe("partial");

    const empty = recordingAdapter();
    await handler.handle(ctxFor(empty, mockClient([{ type: "cancelled" }])));
    expect(empty.sends).toHaveLength(0);
  });

  it("logs an approval_request without crashing (P1-f placeholder)", async () => {
    const warnings: string[] = [];
    const adapter = recordingAdapter();
    const ctx = ctxFor(
      adapter,
      mockClient([
        { type: "text", content: "ok" },
        {
          type: "approval_request",
          request_id: "req-1",
          tool_name: "shell",
          tool_input: { cmd: "rm" },
          description: "run destructive command",
          is_destructive: true,
          diff_preview: null,
        },
        { type: "completed", model: "gpt-test" },
      ]),
    );
    ctx.logger = { ...noopLogger, warn: (m: string) => warnings.push(m) };
    await createDefaultTurnHandler().handle(ctx);
    expect(warnings.some((w) => w.includes("req-1"))).toBe(true);
    expect(adapter.sends[0]?.text).toBe("ok");
  });
});

describe("default turn handler via SessionRouter", () => {
  it("end-to-end: inbound → engine stream → adapter.send", async () => {
    const adapter = recordingAdapter("slack");
    const registry = new AdapterRegistry();
    registry.register(adapter);
    const events: EngineEvent[] = [
      { type: "text", content: "hi from engine" },
      { type: "completed", model: "gpt-test" },
    ];
    const router = new SessionRouter({
      registry,
      clientFactory: () => mockClient(events),
      turnHandler: createDefaultTurnHandler(),
      logger: noopLogger,
    });

    await router.handleInbound({
      platform: "slack",
      chatId: "C9",
      threadId: "T9",
      senderId: "U1",
      senderName: "ed",
      text: "ping",
      timestamp: Date.now(),
    });

    expect(adapter.sends).toHaveLength(1);
    expect(adapter.sends[0]?.text).toBe("hi from engine");
    expect(adapter.sends[0]?.target).toEqual({
      platform: "slack",
      chatId: "C9",
      threadId: "T9",
    });
    await router.stop();
  });
});
