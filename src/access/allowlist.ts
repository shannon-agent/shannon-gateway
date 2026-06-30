import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { type Platform } from "../adapters/types.js";

/**
 * Persisted allowlist of who may drive the agent (F14 access control).
 *
 * Keyed by `{platform, senderId}` — pairing approves a *person*, who can then
 * use the bot in any conversation. Stored as JSON at the given path (atomic
 * tmp+rename); pass `undefined` for an in-memory allowlist (tests).
 *
 * The store is the gateway's source of truth; nothing reads credentials here
 * (those live in the OS keyring — see AdapterContext.getSecret).
 */

export interface AllowlistEntry {
  platform: Platform;
  senderId: string;
  /** Epoch ms when the entry was added. */
  addedAt: number;
}

interface AllowlistFile {
  entries: AllowlistEntry[];
}

export class Allowlist {
  private readonly entries = new Map<string, AllowlistEntry>();

  constructor(private readonly filePath?: string) {
    if (filePath) this.load();
  }

  allow(platform: Platform, senderId: string, addedAt: number = Date.now()): void {
    const entry: AllowlistEntry = { platform, senderId, addedAt };
    this.entries.set(key(platform, senderId), entry);
    this.persist();
  }

  isAllowed(platform: Platform, senderId: string): boolean {
    return this.entries.has(key(platform, senderId));
  }

  revoke(platform: Platform, senderId: string): boolean {
    const removed = this.entries.delete(key(platform, senderId));
    if (removed) this.persist();
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }

  list(): AllowlistEntry[] {
    return [...this.entries.values()];
  }

  private load(): void {
    if (!this.filePath) return;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return; // missing file = empty allowlist (first run)
    }
    try {
      const parsed = JSON.parse(raw) as AllowlistFile;
      if (parsed?.entries && Array.isArray(parsed.entries)) {
        for (const e of parsed.entries) {
          this.entries.set(key(e.platform, e.senderId), e);
        }
      }
    } catch {
      // Corrupt file — start empty rather than crashing the gateway.
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    const payload: AllowlistFile = { entries: this.list() };
    const tmp = `${this.filePath}.tmp`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }
}

function key(platform: Platform, senderId: string): string {
  return `${platform}:${senderId}`;
}
