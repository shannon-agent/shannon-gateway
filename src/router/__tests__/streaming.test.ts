import { describe, expect, it } from "vitest";

import {
  type ChannelAdapter,
  type MessageReceipt,
  type ReplyTarget,
  type SendOpts,
} from "../../adapters/types.js";
import { StreamingReply } from "../streaming.js";

interface RecordedSend {
  text: string;
  opts?: SendOpts;
}

/**
 * Recording adapter: every send() is captured. When `opts.editMessageId` is
 * set, no new id is allocated (the edit targets an existing message); a fresh
 * send returns an incrementing id.
 */
function recordingAdapter(): ChannelAdapter & { calls: RecordedSend[] } {
  const calls: RecordedSend[] = [];
  let next = 1;
  return {
    platform: "telegram",
    capabilities: { threading: false, pairing: false, approvalButtons: false, streaming: "partial" },
    async start() {},
    async stop() {},
    onMessage() {},
    async send(_target: ReplyTarget, text: string, opts?: SendOpts): Promise<MessageReceipt> {
      calls.push({ text, opts });
      const id = opts?.editMessageId ?? `m${next++}`;
      return { messageId: id };
    },
    async requestApproval() {
      return { requestId: "", choice: "deny" };
    },
    resolveSessionConversation(id: string) {
      return { baseChatId: id };
    },
    calls,
  } as unknown as ChannelAdapter & { calls: RecordedSend[] };
}

const target: ReplyTarget = { platform: "telegram", chatId: "C1" };

describe("StreamingReply", () => {
  it("sends the first chunk, then edits in place (throttled)", async () => {
    let clock = 1000;
    const adapter = recordingAdapter();
    const s = new StreamingReply(adapter, target, {
      failurePrefix: "⚠️ ",
      throttleMs: 100,
      now: () => clock,
    });

    await s.ingestText("Hello"); // first → send
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]?.text).toBe("Hello");
    expect(adapter.calls[0]?.opts).toBeUndefined();

    clock += 10; // within throttle window
    await s.ingestText(", world"); // throttled → no edit
    expect(adapter.calls).toHaveLength(1);

    clock += 200; // past window
    await s.ingestText("!");
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]?.opts?.editMessageId).toBe("m1");
    expect(adapter.calls[1]?.text).toBe("Hello, world!");

    await s.finalize({ failed: null, cancelled: false });
    // buffer unchanged since last edit → no extra call
    expect(adapter.calls).toHaveLength(2);
  });

  it("flushes a final edit when text arrived but wasn't throttled out", async () => {
    let clock = 1000;
    const adapter = recordingAdapter();
    const s = new StreamingReply(adapter, target, { failurePrefix: "⚠️ ", throttleMs: 100, now: () => clock });
    await s.ingestText("hi"); // send
    await s.ingestText(" there"); // throttled (clock didn't advance)
    expect(adapter.calls).toHaveLength(1);
    await s.finalize({ failed: null, cancelled: false });
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]?.text).toBe("hi there");
    expect(adapter.calls[1]?.opts?.editMessageId).toBe("m1");
  });

  it("edits the failure prefix onto the existing message on failure", async () => {
    let clock = 1000;
    const adapter = recordingAdapter();
    const s = new StreamingReply(adapter, target, { failurePrefix: "⚠️ ", throttleMs: 100, now: () => clock });
    await s.ingestText("partial");
    await s.finalize({ failed: "engine died", cancelled: false });
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]?.text).toBe("⚠️ engine died");
    expect(adapter.calls[1]?.opts?.editMessageId).toBe("m1");
  });

  it("sends a fresh failure message when nothing was streamed yet", async () => {
    const adapter = recordingAdapter();
    const s = new StreamingReply(adapter, target, { failurePrefix: "⚠️ " });
    await s.finalize({ failed: "boom", cancelled: false });
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]?.text).toBe("⚠️ boom");
    expect(adapter.calls[0]?.opts).toBeUndefined();
  });

  it("suppresses a pure cancel (no text); a cancel with already-streamed text leaves it as-is", async () => {
    let clock = 1000;
    const empty = recordingAdapter();
    const sEmpty = new StreamingReply(empty, target, { failurePrefix: "⚠️ ", now: () => clock });
    await sEmpty.finalize({ failed: null, cancelled: true });
    expect(empty.calls).toHaveLength(0); // pure cancel, no text → suppressed

    const partial = recordingAdapter();
    const sPartial = new StreamingReply(partial, target, { failurePrefix: "⚠️ ", throttleMs: 100, now: () => clock });
    await sPartial.ingestText("some"); // streamed + visible
    await sPartial.finalize({ failed: null, cancelled: true });
    // The partial text was already sent (visible) — cancel leaves it, no extra edit.
    expect(partial.calls).toHaveLength(1);
    expect(partial.calls[0]?.text).toBe("some");
  });

  it("suppresses an empty reply (no text events at all)", async () => {
    const adapter = recordingAdapter();
    const s = new StreamingReply(adapter, target, { failurePrefix: "⚠️ " });
    await s.finalize({ failed: null, cancelled: false });
    expect(adapter.calls).toHaveLength(0);
  });

  it("ignores empty chunks", async () => {
    const adapter = recordingAdapter();
    const s = new StreamingReply(adapter, target, { failurePrefix: "⚠️ " });
    await s.ingestText("");
    expect(s.hasMessage).toBe(false);
    expect(adapter.calls).toHaveLength(0);
  });
});
