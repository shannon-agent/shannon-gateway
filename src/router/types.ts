import {
  type ChannelAdapter,
  type Logger,
  type NormalizedInbound,
  type ReplyTarget,
} from "../adapters/types.js";
import { type EngineWsClient } from "../engine/wsClient.js";

/**
 * Everything a turn handler needs to process one inbound message. The router
 * builds this per inbound and runs it inside the session's lane (so turns are
 * serial within a conversation).
 *
 * The turn handler is the seam between routing (this PR) and per-platform turn
 * behaviour. P1-d lands a default text turn handler; P1-f layers in-channel
 * approval rendering. Tests inject a recording handler.
 */
export interface TurnContext {
  inbound: NormalizedInbound;
  /** Connected engine client scoped to this session (stable session_id → persistence). */
  client: EngineWsClient;
  /** Where replies go — preserves threadId end-to-end (F4). */
  replyTarget: ReplyTarget;
  /** The platform adapter (for send / requestApproval / capabilities). */
  adapter: ChannelAdapter;
  logger: Logger;
}

export interface TurnHandler {
  handle(ctx: TurnContext): Promise<void>;
}
