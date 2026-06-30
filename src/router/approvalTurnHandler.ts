import { type EngineEvent } from "../engine/types.js";
import { respondToApproval } from "../engine/httpClient.js";
import { newAccumulator, sendReply } from "./reply.js";
import { type TurnContext, type TurnHandler } from "./types.js";

/**
 * Approval-aware turn handler.
 *
 * Behaves like the default text handler, but when the engine emits an
 * `approval_request` mid-stream it renders the request in-channel via
 * `adapter.requestApproval` (blocks until the user decides), then POSTs the
 * decision to `/api/approval/respond` so the engine can resume the tool call.
 * The WS stream continues after the POST resolves the engine's pending
 * approval oneshot.
 *
 * If the POST fails (e.g. the engine already timed the request out to Deny at
 * 300s), the turn is not aborted — the failure is logged and the engine will
 * surface the resulting tool outcome in the rest of the stream.
 */
export interface ApprovalTurnHandlerOptions {
  /** Engine HTTP base URL, e.g. `http://127.0.0.1:33420`. */
  engineBaseUrl: string;
  failurePrefix?: string;
  /** Override for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export function createApprovalTurnHandler(
  opts: ApprovalTurnHandlerOptions,
): TurnHandler {
  const failurePrefix = opts.failurePrefix ?? "⚠️ ";
  return {
    async handle(ctx: TurnContext): Promise<void> {
      const { client, adapter, replyTarget, inbound, logger } = ctx;
      const acc = newAccumulator();

      for await (const ev of client.runQuery(inbound.text) as AsyncIterable<EngineEvent>) {
        switch (ev.type) {
          case "text":
            acc.chunks.push(ev.content);
            break;
          case "approval_request": {
            // Engine event fields are snake_case (wire); map to the gateway's
            // camelCase ApprovalReq that the adapter understands.
            const decision = await adapter.requestApproval(replyTarget, {
              requestId: ev.request_id,
              toolName: ev.tool_name,
              toolInput: ev.tool_input,
              description: ev.description,
              isDestructive: ev.is_destructive,
              diffPreview: ev.diff_preview,
            });
            try {
              await respondToApproval({
                engineBaseUrl: opts.engineBaseUrl,
                requestId: decision.requestId,
                choice: decision.choice,
                fetchImpl: opts.fetchImpl,
              });
            } catch (err) {
              logger.warn(
                `approval respond failed for ${decision.requestId}: ${(err as Error).message}`,
              );
            }
            break;
          }
          case "completed":
            break;
          case "failed":
            acc.failed = ev.error;
            break;
          case "cancelled":
            acc.cancelled = true;
            break;
          default:
            // usage / tool_use / tool_result / session_info — not part of the reply text.
            break;
        }
      }

      await sendReply(adapter, replyTarget, acc, failurePrefix);
    },
  };
}
