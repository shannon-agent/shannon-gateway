import { type ChannelAdapter, type NormalizedInbound } from "../adapters/types.js";

/**
 * Compute the router session key for an inbound message.
 *
 * One lane per key. Default policy: `platform:chatId`, with `threadId`
 * appended only when the adapter declares `threading` (Slack thread, Discord
 * thread). On non-threading platforms (TG reply chains, DMs) the chatId is the
 * conversation, so a reply chain stays one session.
 *
 * This is the F5 boundary: same key → serialized; different key → parallel.
 */
export function sessionKeyOf(
  inbound: NormalizedInbound,
  adapter: ChannelAdapter,
): string {
  const base = `${inbound.platform}:${inbound.chatId}`;
  if (inbound.threadId && adapter.capabilities.threading) {
    return `${base}:${inbound.threadId}`;
  }
  return base;
}
