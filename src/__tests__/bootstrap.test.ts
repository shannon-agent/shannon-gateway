import { describe, expect, it, vi } from "vitest";

import {
  type AdapterCapabilities,
  type AdapterContext,
  type ApprovalDecision,
  type ApprovalReq,
  type ChannelAdapter,
  type Logger,
  type MessageReceipt,
  type NormalizedInbound,
  type ReplyTarget,
  type SessionConversation,
} from "../adapters/types.js";
import { type EngineEvent } from "../engine/types.js";
import { type EngineWsClient } from "../engine/wsClient.js";
import { type GatewayConfig } from "../config/types.js";
import { bootstrap, type AdapterFactory } from "../bootstrap.js";

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function mockEngineClient(events: EngineEvent[]): EngineWsClient {
  return {
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    cancel: vi.fn(() => {}),
    runQuery: vi.fn(async function* (): AsyncGenerator<EngineEvent> {
      for (const e of events) yield e;
    }),
  } as unknown as EngineWsClient;
}

interface MockAdapter extends ChannelAdapter {
  sent: Array<{ target: ReplyTarget; text: string }>;
  pushInbound(m: NormalizedInbound): void;
}

function mockAdapter(): MockAdapter {
  let onMsg: ((m: NormalizedInbound) => void) | null = null;
  const sent: MockAdapter["sent"] = [];
  const capabilities: AdapterCapabilities = {
    threading: false,
    pairing: false,
    approvalButtons: false,
    streaming: "none",
  };
  return {
    platform: "slack",
    capabilities,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    onMessage: (h: (m: NormalizedInbound) => void) => {
      onMsg = h;
    },
    send: async (target: ReplyTarget, text: string): Promise<MessageReceipt> => {
      sent.push({ target, text });
      return { messageId: `m${sent.length}` };
    },
    requestApproval: vi.fn(
      async (_t: ReplyTarget, req: ApprovalReq): Promise<ApprovalDecision> => ({
        requestId: req.requestId,
        choice: "allow",
      }),
    ),
    resolveSessionConversation: (id: string): SessionConversation => ({ baseChatId: id }),
    sent,
    pushInbound(m: NormalizedInbound): void {
      onMsg?.(m);
    },
  } as unknown as MockAdapter;
}

const baseConfig: GatewayConfig = {
  engine: { wsUrl: "ws://mock/api/ws", httpBaseUrl: "http://mock" },
  adapters: [{ platform: "slack", enabled: true }],
};

describe("bootstrap", () => {
  it("wires inbound → router → engine → reply end-to-end", async () => {
    const adapter = mockAdapter();
    const factory: AdapterFactory = () => adapter;
    const client = mockEngineClient([
      { type: "text", content: "hello world" },
      { type: "completed", model: "mock" },
    ]);

    const handle = await bootstrap(baseConfig, {
      factories: new Map([["slack", factory]]),
      engineClientFactory: () => client,
      logger: noopLogger,
    });

    expect(handle.adapterCount).toBe(1);
    expect(adapter.start).toHaveBeenCalledTimes(1);

    adapter.pushInbound({
      platform: "slack",
      chatId: "C1",
      senderId: "U1",
      senderName: "ed",
      text: "hi",
      timestamp: Date.now(),
    });

    // onMessage is sync-void; the turn resolves asynchronously in the lane.
    await vi.waitFor(() => {
      expect(adapter.sent.length).toBeGreaterThan(0);
    });
    expect(adapter.sent[0]?.text).toBe("hello world");
    expect(adapter.sent[0]?.target.chatId).toBe("C1");

    await handle.stop();
    expect(adapter.stop).toHaveBeenCalledTimes(1);
  });

  it("throws when an enabled adapter has no factory registered", async () => {
    await expect(bootstrap(baseConfig, { factories: new Map() })).rejects.toThrow(
      /no adapter factory.*slack/,
    );
  });

  it("skips disabled adapters", async () => {
    const cfg: GatewayConfig = {
      engine: { wsUrl: "ws://m/ws", httpBaseUrl: "http://m" },
      adapters: [{ platform: "slack", enabled: false }],
    };
    const handle = await bootstrap(cfg, {
      factories: new Map(),
      engineClientFactory: () => mockEngineClient([]),
      logger: noopLogger,
    });
    expect(handle.adapterCount).toBe(0);
    await handle.stop();
  });

  it("passes keyring secrets to the adapter via AdapterContext", async () => {
    const seen: AdapterContext[] = [];
    const adapter = mockAdapter();
    const factory: AdapterFactory = (_cfg, ctx) => {
      seen.push(ctx);
      return adapter;
    };
    const handle = await bootstrap(
      {
        engine: { wsUrl: "ws://m/ws", httpBaseUrl: "http://m" },
        adapters: [{ platform: "slack", enabled: true }],
      },
      {
        factories: new Map([["slack", factory]]),
        engineClientFactory: () => mockEngineClient([]),
        secretProvider: { get: async (k: string) => (k === "slack/bot-token" ? "tok" : null) },
        logger: noopLogger,
      },
    );
    expect(seen[0]?.getSecret).toBeTypeOf("function");
    expect(await seen[0]?.getSecret("slack/bot-token")).toBe("tok");
    expect(await seen[0]?.getSecret("missing/key")).toBeNull();
    await handle.stop();
  });
});
