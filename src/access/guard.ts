import {
  type ChannelAdapter,
  type Logger,
  type NormalizedInbound,
  type ReplyTarget,
} from "../adapters/types.js";
import { Allowlist } from "./allowlist.js";
import { PairingStore } from "./pairing.js";

/**
 * Access-control decision for one inbound (F14). The host acts on the outcome
 * before the message reaches the router.
 */
export type GuardDecision =
  | { decision: "allow" }
  | { decision: "challenge"; code: string; expiresAt: number }
  | { decision: "deny"; reason: string };

export interface InboundGuard {
  check(inbound: NormalizedInbound): GuardDecision | Promise<GuardDecision>;
}

/**
 * Pairing-based guard.
 *
 * - allowlisted sender → allow
 * - unallowlisted DM (isDirect) → challenge (issue a pairing code; the desktop
 *   app lists pending pairings and the user approves → Allowlist.write)
 * - unallowlisted group mention → deny ("DM the bot to pair first")
 *
 * Groups never trigger a challenge: pairing only happens in a private context,
 * so a stranger can't bootstrap access by @-mentioning the bot in a shared
 * channel.
 */
export class AllowlistGuard implements InboundGuard {
  constructor(
    private readonly allowlist: Allowlist,
    private readonly pairing: PairingStore,
  ) {}

  check(inbound: NormalizedInbound): GuardDecision {
    if (this.allowlist.isAllowed(inbound.platform, inbound.senderId)) {
      return { decision: "allow" };
    }
    if (inbound.isDirect) {
      const record = this.pairing.issue(inbound);
      return {
        decision: "challenge",
        code: record.code,
        expiresAt: record.expiresAt,
      };
    }
    return {
      decision: "deny",
      reason: "You're not paired with this agent yet — send it a direct message to pair.",
    };
  }
}

/**
 * Compose a guard in front of inbound routing. Returns the handler to pass to
 * `adapter.onMessage`:
 *
 *   adapter.onMessage((m) => void guarded(m, adapter));
 *
 * `onAllow` is typically `router.handleInbound` (passed as a callback so this
 * module stays decoupled from the router). Challenge/deny outcomes send an
 * explanatory message to the inbound's reply target and do NOT reach the engine.
 */
export function createGuardedInbound(opts: {
  guard: InboundGuard;
  onAllow: (inbound: NormalizedInbound) => Promise<void>;
  logger: Logger;
}): (inbound: NormalizedInbound, adapter: ChannelAdapter) => Promise<void> {
  const { guard, onAllow, logger } = opts;
  return async (inbound, adapter) => {
    const decision = await guard.check(inbound);
    if (decision.decision === "allow") {
      await onAllow(inbound);
      return;
    }
    const replyTarget: ReplyTarget = {
      platform: inbound.platform,
      chatId: inbound.chatId,
      threadId: inbound.threadId,
    };
    if (decision.decision === "challenge") {
      logger.info(`pairing challenge issued for ${inbound.platform}:${inbound.senderId}`);
      await adapter.send(
        replyTarget,
        `Pairing required — approve code ${decision.code} in the Shannon desktop app. (expires in 5 min)`,
      );
      return;
    }
    logger.info(`denied inbound from ${inbound.platform}:${inbound.senderId} (not paired, group)`);
    await adapter.send(replyTarget, decision.reason);
  };
}
