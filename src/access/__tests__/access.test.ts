import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type ChannelAdapter, type NormalizedInbound, type ReplyTarget } from "../../adapters/types.js";
import { Allowlist } from "../allowlist.js";
import { PairingStore } from "../pairing.js";
import { AllowlistGuard, createGuardedInbound } from "../guard.js";

const tempFiles: string[] = [];
afterEach(() => {
  while (tempFiles.length > 0) {
    const f = tempFiles.pop();
    if (f) rmSync(f, { force: true });
  }
});

function tempPath(): string {
  const p = join(tmpdir(), `gw-allowlist-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  tempFiles.push(p);
  return p;
}

function inbound(overrides: Partial<NormalizedInbound> = {}): NormalizedInbound {
  return {
    platform: "slack",
    chatId: "C1",
    senderId: "U1",
    senderName: "ed",
    text: "hi",
    timestamp: 0,
    ...overrides,
  };
}

describe("Allowlist", () => {
  it("allow / isAllowed / revoke in-memory", () => {
    const al = new Allowlist();
    expect(al.isAllowed("slack", "U1")).toBe(false);
    al.allow("slack", "U1");
    expect(al.isAllowed("slack", "U1")).toBe(true);
    expect(al.size).toBe(1);
    expect(al.revoke("slack", "U1")).toBe(true);
    expect(al.isAllowed("slack", "U1")).toBe(false);
  });

  it("persists across instances via the file path", () => {
    const path = tempPath();
    const a = new Allowlist(path);
    a.allow("slack", "U1");
    a.allow("telegram", "U2");

    const b = new Allowlist(path); // reloads
    expect(b.isAllowed("slack", "U1")).toBe(true);
    expect(b.isAllowed("telegram", "U2")).toBe(true);
    expect(b.size).toBe(2);
  });

  it("survives a missing file (first run)", () => {
    const al = new Allowlist(tempPath());
    expect(al.size).toBe(0);
  });
});

describe("PairingStore", () => {
  it("issue then consume is single-use", () => {
    const store = new PairingStore();
    const rec = store.issue(inbound({ senderId: "U1", isDirect: true }));
    expect(rec.code).toMatch(/^\d{6}$/);

    const consumed = store.consume(rec.code);
    expect(consumed?.senderId).toBe("U1");

    // Second consume of the same code fails.
    expect(store.consume(rec.code)).toBeNull();
  });

  it("expired codes are rejected", () => {
    let clock = 1000;
    const store = new PairingStore(5_000, () => clock);
    const rec = store.issue(inbound({ senderId: "U1", isDirect: true }));
    expect(rec.expiresAt).toBe(6_000);

    clock = 7_000; // past expiry
    expect(store.consume(rec.code)).toBeNull();
  });

  it("a fresh code before TTL is consumable", () => {
    let clock = 1000;
    const store = new PairingStore(5_000, () => clock);
    const rec = store.issue(inbound({ senderId: "U1", isDirect: true }));
    clock = 4_000; // within TTL
    expect(store.consume(rec.code)?.senderId).toBe("U1");
  });
});

describe("AllowlistGuard", () => {
  it("allows an allowlisted sender", () => {
    const al = new Allowlist();
    al.allow("slack", "U1");
    const guard = new AllowlistGuard(al, new PairingStore());
    expect(guard.check(inbound({ senderId: "U1" }))).toEqual({ decision: "allow" });
  });

  it("challenges an unallowlisted DM with a code", () => {
    const guard = new AllowlistGuard(new Allowlist(), new PairingStore());
    const decision = guard.check(inbound({ senderId: "U2", isDirect: true }));
    expect(decision.decision).toBe("challenge");
    if (decision.decision === "challenge") {
      expect(decision.code).toMatch(/^\d{6}$/);
      expect(decision.expiresAt).toBeGreaterThan(0);
    }
  });

  it("denies an unallowlisted group mention without issuing a code", () => {
    const pairing = new PairingStore();
    const guard = new AllowlistGuard(new Allowlist(), pairing);
    const decision = guard.check(inbound({ senderId: "U3", isDirect: false }));
    expect(decision.decision).toBe("deny");
    expect(pairing.pendingCount).toBe(0); // no code leaked for a group message
  });
});

describe("createGuardedInbound", () => {
  function recordingAdapter(): ChannelAdapter & {
    sends: Array<{ target: ReplyTarget; text: string }>;
  } {
    const sends: Array<{ target: ReplyTarget; text: string }> = [];
    return {
      platform: "slack",
      capabilities: { threading: false, pairing: true, approvalButtons: false, streaming: "none" },
      start: async () => {},
      stop: async () => {},
      onMessage: () => {},
      send: async (target, text) => {
        sends.push({ target, text });
        return { messageId: "m" };
      },
      requestApproval: async (_t, req) => ({ requestId: req.requestId, choice: "allow" as const }),
      resolveSessionConversation: (id) => ({ baseChatId: id }),
      sends,
    };
  }

  it("routes allow to onAllow and does not message", async () => {
    const al = new Allowlist();
    al.allow("slack", "U1");
    const onAllow = vi.fn(async () => {});
    const adapter = recordingAdapter();
    const guarded = createGuardedInbound({
      guard: new AllowlistGuard(al, new PairingStore()),
      onAllow,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    await guarded(inbound({ senderId: "U1" }), adapter);
    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(adapter.sends).toHaveLength(0);
  });

  it("sends a pairing prompt on challenge and does not route", async () => {
    const onAllow = vi.fn(async () => {});
    const adapter = recordingAdapter();
    const guarded = createGuardedInbound({
      guard: new AllowlistGuard(new Allowlist(), new PairingStore()),
      onAllow,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    await guarded(inbound({ senderId: "U2", isDirect: true, threadId: "T1" }), adapter);
    expect(onAllow).not.toHaveBeenCalled();
    expect(adapter.sends).toHaveLength(1);
    expect(adapter.sends[0]?.text).toMatch(/Pairing required/);
    expect(adapter.sends[0]?.target.threadId).toBe("T1");
  });

  it("sends the deny reason and does not route", async () => {
    const onAllow = vi.fn(async () => {});
    const adapter = recordingAdapter();
    const guarded = createGuardedInbound({
      guard: new AllowlistGuard(new Allowlist(), new PairingStore()),
      onAllow,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    await guarded(inbound({ senderId: "U3", isDirect: false }), adapter);
    expect(onAllow).not.toHaveBeenCalled();
    expect(adapter.sends[0]?.text).toMatch(/not paired/);
  });
});
