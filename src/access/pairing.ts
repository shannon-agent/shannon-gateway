import { randomInt } from "node:crypto";

import { type NormalizedInbound, type Platform } from "../adapters/types.js";

/**
 * Short-lived, single-use pairing codes that bootstrap the allowlist.
 *
 * When an unallowlisted user DMs the bot, the guard issues a 6-digit code via
 * `issue()`; the desktop app lists pending pairings and the user approves one,
 * which calls `consume()` → on success the host writes the sender to the
 * Allowlist (persisted) and they're in.
 *
 * Codes are in-memory only (ephemeral by design), expire after `ttlMs`
 * (default 5 min), and are single-use. Expired entries are pruned on each
 * issue/consume so the pending set can't grow unbounded.
 */

export interface PairingRecord {
  code: string;
  platform: Platform;
  senderId: string;
  createdAt: number;
  expiresAt: number;
}

export class PairingStore {
  private readonly pending = new Map<string, PairingRecord>();

  constructor(
    private readonly ttlMs: number = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  issue(inbound: NormalizedInbound): PairingRecord {
    this.pruneExpired();
    const code = generateCode();
    const createdAt = this.now();
    const record: PairingRecord = {
      code,
      platform: inbound.platform,
      senderId: inbound.senderId,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.pending.set(code, record);
    return record;
  }

  /** Validate and consume a code. Returns the record on success, null otherwise. */
  consume(code: string): PairingRecord | null {
    this.pruneExpired();
    const record = this.pending.get(code);
    if (!record) return null;
    this.pending.delete(code); // single-use
    return record;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [code, record] of this.pending) {
      if (record.expiresAt < now) this.pending.delete(code);
    }
  }
}

function generateCode(): string {
  // 6-digit numeric — short enough to read in a desktop dialog, long enough to
  // resist guessing within the 5-min TTL.
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
