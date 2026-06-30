import { type EngineEvent } from "../engine/types.js";
import { newAccumulator, sendReply } from "./reply.js";
import { canStream, StreamingReply } from "./streaming.js";
import { type TurnContext, type TurnHandler } from "./types.js";

/**
 * Default turn handler: text reply, block-mode OR streaming per adapter.
 *
 * Runs the engine query and renders the assistant reply:
 *   - `streaming: "partial"` adapters → `StreamingReply` (send first chunk,
 *     edit in place as more text arrives, throttled; final edit on completion).
 *   - otherwise → block mode (one message at the end via `sendReply`).
 *
 * The replyTarget is built by the router from the inbound, so `threadId` is
 * carried end-to-end (F4 fixed at the gateway level) — the per-platform
 * adapter translates it (Slack `thread_ts` etc.) in P1-g.
 *
 * Approval: this handler does NOT render approval buttons. If an
 * `approval_request` arrives it is logged and the loop continues — with a real
 * engine the turn then blocks until the tool is responded to or times out.
 * Deployments that register approval-capable adapters should use the
 * approval-aware handler (P1-f) instead of, or wrapped around, this one.
 *
 * Reply policy (failure prefix, cancel suppression, empty-reply suppression)
 * lives in `reply.ts` and is shared with the approval handler + `StreamingReply`.
 */
export interface DefaultTurnHandlerOptions {
  /** Prefix on the outbound message when the engine reports a failure. */
  failurePrefix?: string;
  /** Min ms between streaming progress edits (default 1500). */
  streamThrottleMs?: number;
}

export function createDefaultTurnHandler(
  opts: DefaultTurnHandlerOptions = {},
): TurnHandler {
  const failurePrefix = opts.failurePrefix ?? "⚠️ ";
  return {
    async handle(ctx: TurnContext): Promise<void> {
      const { client, adapter, replyTarget, inbound, logger } = ctx;
      const acc = newAccumulator();
      const stream = canStream(adapter)
        ? new StreamingReply(adapter, replyTarget, {
            failurePrefix,
            throttleMs: opts.streamThrottleMs ?? adapter.capabilities.progressThrottleMs,
          })
        : null;

      for await (const ev of client.runQuery(inbound.text) as AsyncIterable<EngineEvent>) {
        switch (ev.type) {
          case "text":
            if (stream) await stream.ingestText(ev.content);
            else acc.chunks.push(ev.content);
            break;
          case "completed":
            break;
          case "failed":
            acc.failed = ev.error;
            break;
          case "cancelled":
            acc.cancelled = true;
            break;
          case "approval_request":
            logger.warn(
              `approval_request ${ev.request_id} arrived but no approval handler is wired (see P1-f); ` +
                `turn will block until the engine resolves the tool`,
            );
            break;
          default:
            // usage / tool_use / tool_result / session_info — not part of the reply text.
            break;
        }
      }

      if (stream) {
        await stream.finalize({ failed: acc.failed, cancelled: acc.cancelled });
      } else {
        await sendReply(adapter, replyTarget, acc, failurePrefix);
      }
    },
  };
}
