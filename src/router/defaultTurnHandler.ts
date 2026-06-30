import { type EngineEvent } from "../engine/types.js";
import { type TurnContext, type TurnHandler } from "./types.js";

/**
 * Default turn handler: block-mode text reply.
 *
 * Runs the engine query, accumulates assistant text chunks, and sends a single
 * outbound message on completion via `adapter.send(replyTarget, …)`. The
 * replyTarget is built by the router from the inbound, so `threadId` is
 * carried end-to-end (F4 fixed at the gateway level) — the per-platform
 * adapter translates it (Slack `thread_ts` etc.) in P1-g.
 *
 * Block mode (one final message) is the MVP. Streaming / edit-in-place progress
 * is a later phase keyed off `adapter.capabilities.streaming`.
 *
 * Approval: this handler does NOT render approval buttons. If an
 * `approval_request` arrives it is logged and the loop continues — with a real
 * engine the turn then blocks until the tool is responded to or times out.
 * Deployments that register approval-capable adapters should use the
 * approval-aware handler (P1-f) instead of, or wrapped around, this one.
 */
export interface DefaultTurnHandlerOptions {
  /** Prefix on the outbound message when the engine reports a failure. */
  failurePrefix?: string;
}

export function createDefaultTurnHandler(
  opts: DefaultTurnHandlerOptions = {},
): TurnHandler {
  const failurePrefix = opts.failurePrefix ?? "⚠️ ";
  return {
    async handle(ctx: TurnContext): Promise<void> {
      const { client, adapter, replyTarget, inbound, logger } = ctx;
      const chunks: string[] = [];
      let failed: string | null = null;
      let cancelled = false;

      for await (const ev of client.runQuery(inbound.text) as AsyncIterable<EngineEvent>) {
        switch (ev.type) {
          case "text":
            chunks.push(ev.content);
            break;
          case "completed":
            break;
          case "failed":
            failed = ev.error;
            break;
          case "cancelled":
            cancelled = true;
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

      const text = chunks.join("");

      if (failed !== null) {
        await adapter.send(replyTarget, `${failurePrefix}${failed}`);
        return;
      }
      if (cancelled) {
        // Suppress pure-cancel noise; only forward if there was partial content.
        if (text.length > 0) await adapter.send(replyTarget, text);
        return;
      }
      // completed (or stream ended without a terminal frame) — forward any text.
      if (text.length > 0) {
        await adapter.send(replyTarget, text);
      }
    },
  };
}
