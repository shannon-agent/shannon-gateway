import {
  type ChannelAdapter,
  type MessageReceipt,
  type ReplyTarget,
} from "../adapters/types.js";

/**
 * Send-then-edit streaming controller (Phase 2, D3).
 *
 * Used by the turn handlers when `adapter.capabilities.streaming === "partial"`.
 * For `"none"` / `"block"` adapters the handlers fall back to the block-mode
 * `sendReply` (one message at the end) instead of constructing one of these.
 *
 * Lifecycle:
 *   1. First text chunk → `adapter.send(target, chunk)` → remember the
 *      `messageId` (the message we'll edit in place).
 *   2. Subsequent chunks → edit in place, but no more often than `throttleMs`
 *      (platform flood-control avoidance — TG in particular).
 *   3. `finalize()` → one last edit carrying the full text, with the same
 *      terminal policy as block mode (failure prefix, pure-cancel suppression,
 *      empty-reply suppression).
 *
 * The adapter's `send` must honor `opts.editMessageId` (call the platform's
 * edit endpoint) for this to actually edit rather than duplicate — that is the
 * `streaming: "partial"` contract. Edit failures on `finalize` fall back to a
 * fresh send so a reply is never lost.
 */
export interface StreamingReplyOptions {
  failurePrefix: string;
  /** Minimum ms between progress edits. Default 1500. */
  throttleMs?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface TerminalState {
  failed: string | null;
  cancelled: boolean;
}

export class StreamingReply {
  private readonly adapter: ChannelAdapter;
  private readonly target: ReplyTarget;
  private readonly failurePrefix: string;
  private readonly throttleMs: number;
  private readonly now: () => number;
  private messageId: string | null = null;
  private buffer = "";
  private lastEditAt = 0;
  private dirty = false;

  constructor(adapter: ChannelAdapter, target: ReplyTarget, opts: StreamingReplyOptions) {
    this.adapter = adapter;
    this.target = target;
    this.failurePrefix = opts.failurePrefix;
    this.throttleMs = opts.throttleMs ?? 1500;
    this.now = opts.now ?? Date.now;
  }

  /** True once an initial message exists (and is being edited in place). */
  get hasMessage(): boolean {
    return this.messageId !== null;
  }

  /** Ingest a text chunk: send the first, edit the rest (throttled). */
  async ingestText(chunk: string): Promise<void> {
    if (chunk.length === 0) return;
    this.buffer += chunk;
    this.dirty = true;
    if (this.messageId === null) {
      const receipt: MessageReceipt = await this.adapter.send(this.target, this.buffer);
      this.messageId = receipt.messageId.length > 0 ? receipt.messageId : null;
      this.lastEditAt = this.now();
      this.dirty = false;
      return;
    }
    if (this.now() - this.lastEditAt >= this.throttleMs) {
      await this.edit();
    }
  }

  /** Final flush + terminal handling. Call once after the event stream ends. */
  async finalize(state: TerminalState): Promise<void> {
    if (state.failed !== null) {
      const text = `${this.failurePrefix}${state.failed}`;
      if (this.messageId !== null) {
        try {
          await this.adapter.send(this.target, text, { editMessageId: this.messageId });
          return;
        } catch {
          // Edit failed (e.g. outside the platform edit window) — send fresh.
        }
      }
      await this.adapter.send(this.target, text);
      return;
    }
    // Pure cancel with no partial text → suppress (matches block-mode policy).
    if (state.cancelled && this.buffer.length === 0) return;
    if (this.buffer.length === 0) return; // nothing to say
    if (this.dirty || this.messageId === null) {
      if (this.messageId !== null) {
        await this.edit();
      } else {
        await this.adapter.send(this.target, this.buffer);
      }
    }
  }

  private async edit(): Promise<void> {
    if (this.messageId === null) return;
    await this.adapter.send(this.target, this.buffer, { editMessageId: this.messageId });
    this.lastEditAt = this.now();
    this.dirty = false;
  }
}

/** Decide whether an adapter should stream (vs block). */
export function canStream(adapter: ChannelAdapter): boolean {
  return adapter.capabilities.streaming === "partial";
}
