import { type ChannelAdapter, type ReplyTarget } from "../adapters/types.js";

/**
 * Shared turn-output state + final reply send. Both the default text handler
 * (P1-d) and the approval-aware handler (P1-f) accumulate engine frames into
 * one of these and call `sendReply` once the stream ends, so the reply policy
 * (failure prefix, cancel suppression, empty-reply suppression) stays in one
 * place.
 */
export interface TurnAccumulator {
  chunks: string[];
  failed: string | null;
  cancelled: boolean;
}

export function newAccumulator(): TurnAccumulator {
  return { chunks: [], failed: null, cancelled: false };
}

export async function sendReply(
  adapter: ChannelAdapter,
  replyTarget: ReplyTarget,
  acc: TurnAccumulator,
  failurePrefix: string,
): Promise<void> {
  if (acc.failed !== null) {
    await adapter.send(replyTarget, `${failurePrefix}${acc.failed}`);
    return;
  }
  const text = acc.chunks.join("");
  if (acc.cancelled) {
    // Suppress pure-cancel noise; only forward if there was partial content.
    if (text.length > 0) await adapter.send(replyTarget, text);
    return;
  }
  // completed (or stream ended without a terminal frame) — forward any text.
  if (text.length > 0) await adapter.send(replyTarget, text);
}
