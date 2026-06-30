import { describe, expect, it, vi } from "vitest";

import {
  type AdapterCapabilities,
  type ChannelAdapter,
  type Logger,
  type NormalizedInbound,
  type Platform,
} from "../../adapters/types.js";
import { AdapterRegistry } from "../../adapters/registry.js";
import { type EngineWsClient } from "../../engine/wsClient.js";
import { SessionLane } from "../lane.js";
import { SessionRouter } from "../router.js";
import { sessionKeyOf } from "../sessionKey.js";
import { type TurnHandler } from "../types.js";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeAdapter(
  platform: Platform,
  caps: Partial<AdapterCapabilities> = {},
): ChannelAdapter {
  return {
    platform,
    capabilities: {
      threading: false,
      pairing: false,
      approvalButtons: false,
      streaming: "none",
      ...caps,
    },
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    send: async () => ({ messageId: "m" }),
    requestApproval: async (_t, req) => ({
      requestId: req.requestId,
      choice: "allow" as const,
    }),
    resolveSessionConversation: (id) => ({ baseChatId: id }),
  };
}

function makeMockClient(): EngineWsClient {
  return {
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } as unknown as EngineWsClient;
}

function inb(
  chatId: string,
  text: string,
  opts: { threadId?: string; platform?: Platform } = {},
): NormalizedInbound {
  return {
    platform: opts.platform ?? "slack",
    chatId,
    threadId: opts.threadId,
    senderId: "U1",
    senderName: "ed",
    text,
    timestamp: Date.now(),
  };
}

function makeRouter(adapter: ChannelAdapter, handler: TurnHandler, clientFactory: () => EngineWsClient): SessionRouter {
  const registry = new AdapterRegistry();
  registry.register(adapter);
  return new SessionRouter({ registry, clientFactory, turnHandler: handler, logger: noopLogger });
}

describe("sessionKeyOf", () => {
  it("appends threadId only when the adapter declares threading", () => {
    const threading = makeAdapter("slack", { threading: true });
    const flat = makeAdapter("slack", { threading: false });
    const msg = inb("C1", "x", { threadId: "T1" });
    expect(sessionKeyOf(msg, threading)).toBe("slack:C1:T1");
    expect(sessionKeyOf(msg, flat)).toBe("slack:C1");
  });

  it("ignores an undefined threadId even on threading adapters", () => {
    const threading = makeAdapter("slack", { threading: true });
    expect(sessionKeyOf(inb("C1", "x"), threading)).toBe("slack:C1");
  });
});

describe("SessionLane", () => {
  it("runs tasks strictly in arrival order", async () => {
    const lane = new SessionLane("k", makeMockClient, noopLogger);
    const order: string[] = [];
    const task = (label: string): Promise<void> =>
      lane.enqueue(async () => {
        order.push(`start:${label}`);
        await tick();
        order.push(`end:${label}`);
      });

    await Promise.all([task("a"), task("b"), task("c")]);
    expect(order).toEqual([
      "start:a",
      "end:a",
      "start:b",
      "end:b",
      "start:c",
      "end:c",
    ]);
  });

  it("keeps the chain alive after a rejected task", async () => {
    const lane = new SessionLane("k", makeMockClient, noopLogger);
    const p1 = lane.enqueue(async () => {
      throw new Error("boom");
    });
    await expect(p1).rejects.toThrow("boom");

    let ran = false;
    await lane.enqueue(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("creates the engine client once and reuses it", async () => {
    const factory = vi.fn(makeMockClient);
    const lane = new SessionLane("k", factory, noopLogger);
    // Touch getClient twice — should memoize.
    const [a, b] = await Promise.all([lane.getClient(), lane.getClient()]);
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe("SessionRouter", () => {
  it("serializes same-session turns and parallelizes across sessions", async () => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const handler: TurnHandler = {
      async handle({ inbound }) {
        active += 1;
        peak = Math.max(peak, active);
        order.push(`start:${inbound.text}`);
        await tick();
        order.push(`end:${inbound.text}`);
        active -= 1;
      },
    };
    const router = makeRouter(makeAdapter("slack"), handler, makeMockClient);

    await Promise.all([
      router.handleInbound(inb("C1", "a1")),
      router.handleInbound(inb("C1", "a2")),
      router.handleInbound(inb("C2", "b1")),
    ]);

    // Cross-session overlap happened.
    expect(peak).toBeGreaterThanOrEqual(2);
    // Within C1: a1 fully completes before a2 starts.
    const endA1 = order.indexOf("end:a1");
    const startA2 = order.indexOf("start:a2");
    expect(startA2).toBeGreaterThan(endA1);
    expect(router.laneCount).toBe(2);
  });

  it("reuses one engine client per session across turns", async () => {
    const factory = vi.fn(makeMockClient);
    const handler: TurnHandler = { async handle() {} };
    const router = makeRouter(makeAdapter("slack"), handler, factory);

    await Promise.all([
      router.handleInbound(inb("C1", "first")),
      router.handleInbound(inb("C1", "second")),
    ]);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("drops inbound from an unregistered platform", async () => {
    const handler = vi.fn(async () => {});
    const router = makeRouter(makeAdapter("slack"), { handle: handler }, makeMockClient);

    await router.handleInbound(inb("C1", "x", { platform: "discord" }));
    expect(handler).not.toHaveBeenCalled();
    expect(router.laneCount).toBe(0);
  });

  it("one failed turn does not block later turns in the same session", async () => {
    let calls = 0;
    const handler: TurnHandler = {
      async handle() {
        calls += 1;
        if (calls === 1) throw new Error("boom");
      },
    };
    const router = makeRouter(makeAdapter("slack"), handler, makeMockClient);

    await expect(router.handleInbound(inb("C1", "first"))).rejects.toThrow("boom");
    await router.handleInbound(inb("C1", "second"));
    expect(calls).toBe(2);
  });

  it("stop() closes every lane's engine client", async () => {
    const clients = [makeMockClient(), makeMockClient()];
    let i = 0;
    const router = makeRouter(makeAdapter("slack"), { async handle() {} }, () => clients[i++]!);

    await router.handleInbound(inb("C1", "a"));
    await router.handleInbound(inb("C2", "b"));
    await router.stop();

    expect(clients[0]?.close).toHaveBeenCalled();
    expect(clients[1]?.close).toHaveBeenCalled();
  });
});
