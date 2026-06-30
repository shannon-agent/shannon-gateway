import { describe, expect, it, vi } from "vitest";

import { ContractError, assertAdapterContract } from "../contract.js";
import { AdapterRegistry } from "../registry.js";
import {
  type AdapterContext,
  type ApprovalDecision,
  type ChannelAdapter,
  type MessageReceipt,
  type NormalizedInbound,
  type Platform,
  type ReplyTarget,
  type SessionConversation,
  type ApprovalReq,
} from "../types.js";

/** Build a complete no-op adapter for tests. */
function makeFakeAdapter(platform: Platform = "slack"): ChannelAdapter {
  return {
    platform,
    capabilities: {
      threading: true,
      pairing: true,
      approvalButtons: true,
      streaming: "partial",
    },
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    onMessage: vi.fn(),
    send: vi.fn(async (_t: ReplyTarget, _text: string): Promise<MessageReceipt> => ({
      messageId: "m1",
    })),
    requestApproval: vi.fn(
      async (_t: ReplyTarget, req: ApprovalReq): Promise<ApprovalDecision> => ({
        requestId: req.requestId,
        choice: "allow",
      }),
    ),
    resolveSessionConversation: vi.fn(
      (rawId: string): SessionConversation => ({ baseChatId: rawId }),
    ),
  };
}

const noopCtx: AdapterContext = {
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
  getSecret: async () => null,
};

describe("assertAdapterContract", () => {
  it("accepts a well-formed adapter", () => {
    expect(() => assertAdapterContract(makeFakeAdapter())).not.toThrow();
  });

  it("rejects an unknown platform", () => {
    const a = makeFakeAdapter();
    (a as { platform: string }).platform = "icq";
    expect(() => assertAdapterContract(a)).toThrow(ContractError);
  });

  it("rejects a non-function method", () => {
    const a = makeFakeAdapter() as unknown as Record<string, unknown>;
    a.send = "not a fn";
    expect(() => assertAdapterContract(a)).toThrow(/send must be a function/);
  });

  it("rejects an invalid streaming capability", () => {
    const a = makeFakeAdapter();
    (a.capabilities as { streaming: string }).streaming = "turbo";
    expect(() => assertAdapterContract(a)).toThrow(/streaming/);
  });
});

describe("AdapterRegistry", () => {
  it("register/get/all round-trip", () => {
    const reg = new AdapterRegistry();
    const slack = makeFakeAdapter("slack");
    const tg = makeFakeAdapter("telegram");
    reg.register(slack);
    reg.register(tg);

    expect(reg.size).toBe(2);
    expect(reg.get("slack")).toBe(slack);
    expect(reg.get("telegram")).toBe(tg);
    expect(reg.get("discord")).toBeUndefined();
    expect(reg.all()).toEqual([slack, tg]);
  });

  it("rejects a duplicate platform", () => {
    const reg = new AdapterRegistry();
    reg.register(makeFakeAdapter("slack"));
    expect(() => reg.register(makeFakeAdapter("slack"))).toThrow(/already registered/);
  });

  it("register runs the contract check (rejects malformed)", () => {
    const reg = new AdapterRegistry();
    const bad = makeFakeAdapter();
    (bad as unknown as Record<string, unknown>).start = null;
    expect(() => reg.register(bad)).toThrow(ContractError);
  });

  it("startAll/stopAll hit every adapter", async () => {
    const reg = new AdapterRegistry();
    const slack = makeFakeAdapter("slack");
    const tg = makeFakeAdapter("telegram");
    reg.register(slack);
    reg.register(tg);
    await reg.startAll(noopCtx);
    await reg.stopAll();

    expect(slack.start).toHaveBeenCalledWith(noopCtx);
    expect(tg.start).toHaveBeenCalledWith(noopCtx);
    expect(slack.stop).toHaveBeenCalled();
    expect(tg.stop).toHaveBeenCalled();
  });

  it("stopAll runs every adapter even if one throws", async () => {
    const reg = new AdapterRegistry();
    const slack = makeFakeAdapter("slack");
    const tg = makeFakeAdapter("telegram");
    (slack.stop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    reg.register(slack);
    reg.register(tg);

    await expect(reg.stopAll()).rejects.toThrow("boom");
    // tg.stop still ran despite slack throwing.
    expect(tg.stop).toHaveBeenCalled();
  });

  it("get() returns a working adapter whose onMessage delivers inbound", async () => {
    const reg = new AdapterRegistry();
    let stored: ((m: NormalizedInbound) => void) | null = null;
    const slack: ChannelAdapter = {
      ...makeFakeAdapter("slack"),
      onMessage: (h) => {
        stored = h;
      },
    };
    reg.register(slack);

    const adapter = reg.get("slack");
    expect(adapter).toBe(slack);
    const received: NormalizedInbound[] = [];
    adapter!.onMessage((m) => received.push(m));

    const inbound: NormalizedInbound = {
      platform: "slack",
      chatId: "C1",
      threadId: "T1",
      senderId: "U1",
      senderName: "ed",
      text: "hello",
      timestamp: Date.now(),
    };
    stored!(inbound);
    expect(received).toEqual([inbound]);
  });
});
