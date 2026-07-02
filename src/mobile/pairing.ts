/**
 * P1.2 device pairing & registration. Establishes strong device identity
 * (Ed25519, no account server — architecture doc D3) so the gateway can gate
 * sensitive methods and cryptographically authenticate approval decisions.
 *
 * Three pieces:
 *  - `PairTokenStore`: one-time, short-TTL tokens shown in the desktop QR (P1.3
 *    calls `issue()`; the phone consumes one via `shannon/pair`). Single-use +
 *    replay-proof. In-memory only — a token that survives a restart is a worse
 *    secret, not a better one.
 *  - `DeviceRegistry`: the persisted allowlist of paired devices (device_id →
 *    public key + label + timestamps). Atomic JSON file, modeled on the
 *    channel-adapter `Allowlist`. Public keys aren't secret, so a data file
 *    (NOT config.json) satisfies F14's "credentials not in config/repo".
 *  - handlers for `shannon/pair` + `shannon/device.resume`, and a composer
 *    (`createMobileHandlers`) that merges them with the engine bridge and wires
 *    the session gate + approval-signature verifier.
 *
 * Security shape:
 *  - pair consumes the token, verifies proof-of-possession, registers the key,
 *    binds ctx.sessionId. All pair failures return the same generic error to
 *    avoid a token-enumeration oracle.
 *  - device.resume verifies a timestamped signature (±clock skew) and rebinds.
 *  - With `requireSession` on, query/cancel/approval require a bound session
 *    (PAIRING_REQUIRED) and every approval decision must carry a valid device
 *    signature over `${request_id}:${choice}`.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Logger } from "../adapters/types.js";
import {
  deviceIdFromPublicKey,
  generatePairToken,
  pairPopMessage,
  resumeMessage,
  verifyMessage,
} from "./crypto.js";
import {
  ShannonError,
  type DeviceResumeParams,
  type DeviceSessionResult,
  type PairParams,
} from "./protocol.js";
import type { MethodContext, MethodHandlers } from "./server.js";
import {
  createEngineHandlers,
  type DeviceSignatureVerifier,
  type EngineBridgeOptions,
} from "./engineBridge.js";

// ── PairTokenStore ──────────────────────────────────────────────────────────

export interface PairTokenRecord {
  token: string;
  issuedAt: number;
  expiresAt: number;
}

export interface PairTokenStoreOptions {
  /** TTL in ms (default 75_000 — within the 60-90s design window). */
  ttlMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /**
   * Optional JSONL file path. When set, the store is **file-backed**: `issue`
   * appends a record and `consume` does an atomic read-modify-write against the
   * file. This is the Design-D control channel — the desktop (Rust) appends
   * tokens here for the QR, and the gateway (TS) consumes them on `shannon/pair`.
   * Omit for the in-memory store used by unit tests.
   */
  filePath?: string;
}

export class PairTokenStore {
  /** Used only in memory mode (no `filePath`). */
  private readonly pending = new Map<string, PairTokenRecord>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly filePath?: string;

  constructor(opts: PairTokenStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 75_000;
    this.now = opts.now ?? Date.now;
    this.filePath = opts.filePath;
  }

  /**
   * Mint a fresh one-time token. The desktop QR (P1.3) displays it. In file mode
   * the record is appended to disk so a separate consumer process (the gateway)
   * can validate it; in memory mode it lives in the `pending` map.
   */
  issue(): PairTokenRecord {
    if (!this.filePath) this.pruneExpired();
    const issuedAt = this.now();
    const record: PairTokenRecord = {
      token: generatePairToken(),
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
    };
    if (this.filePath) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, JSON.stringify(record) + "\n", "utf8");
    } else {
      this.pending.set(record.token, record);
    }
    return record;
  }

  /**
   * Validate and consume a token (single-use). Returns the record on success,
   * null on miss / expiry / replay. Deletion is unconditional on lookup so a
   * replay after expiry is still consumed — a leaked token can't be revived.
   *
   * In file mode this reads the JSONL, removes the matching line (plus any
   * expired siblings, opportunistically), and rewrites atomically via tmp+rename.
   * Concurrency: the desktop appends with O_APPEND; we only rewrite when we
   * actually remove a line, so a desktop append that lands between our read and
   * rename is lost only in the rare window of a concurrent consume — a user can
   * always mint a fresh token. Acceptable for the low-frequency pairing path.
   */
  consume(token: string): PairTokenRecord | null {
    if (!this.filePath) {
      const record = this.pending.get(token);
      this.pending.delete(token);
      if (!record) return null;
      if (this.now() >= record.expiresAt) return null;
      return record;
    }
    return this.consumeFromFile(token);
  }

  private consumeFromFile(token: string): PairTokenRecord | null {
    let raw: string;
    try {
      raw = readFileSync(this.filePath!, "utf8");
    } catch {
      return null; // no file yet → no tokens
    }
    const now = this.now();
    let consumed: PairTokenRecord | null = null;
    const survivors: PairTokenRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let rec: PairTokenRecord;
      try {
        rec = JSON.parse(trimmed) as PairTokenRecord;
      } catch {
        continue; // tolerate a malformed line rather than failing the pair
      }
      if (typeof rec.token !== "string" || typeof rec.expiresAt !== "number") continue;
      if (rec.token === token) {
        // Match: consume unconditionally (single-use). Valid only if not expired.
        consumed = now < rec.expiresAt ? rec : null;
        continue; // drop from survivors
      }
      // Prune expired siblings opportunistically; keep the rest.
      if (now < rec.expiresAt) survivors.push(rec);
    }
    if (consumed !== null) {
      // Rewrite without the consumed token (and without expired siblings).
      this.rewriteFile(this.filePath!, survivors);
    } else if (raw.trim().length === 0) {
      // No-op: nothing to persist.
    }
    // When the token was absent, we do NOT rewrite (avoid clobbering concurrent
    // desktop appends for a miss).
    return consumed;
  }

  private rewriteFile(path: string, records: PairTokenRecord[]): void {
    const payload = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
    const tmp = `${path}.tmp`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, payload, "utf8");
    renameSync(tmp, path);
  }

  /** Number of outstanding tokens — meaningful in memory mode only. */
  get size(): number {
    return this.pending.size;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [token, record] of this.pending) {
      if (now >= record.expiresAt) this.pending.delete(token);
    }
  }
}

// ── DeviceRegistry ──────────────────────────────────────────────────────────

export interface DeviceEntry {
  device_id: string;
  /** JWK `x` — base64url of the 32-byte Ed25519 public key. */
  public_key: string;
  label: string | null;
  added_at: number;
  last_seen_at: number;
}

interface DeviceRegistryFile {
  entries: DeviceEntry[];
}

export interface DeviceRegistryOptions {
  /**
   * Path to the JSON data file. `undefined` → in-memory (tests). Must NOT be
   * config.json (F14: device credentials stay out of config/repo).
   */
  filePath?: string;
  now?: () => number;
}

export class DeviceRegistry {
  private readonly entries = new Map<string, DeviceEntry>();
  private readonly filePath?: string;
  private readonly now: () => number;

  constructor(opts: DeviceRegistryOptions = {}) {
    this.filePath = opts.filePath;
    this.now = opts.now ?? Date.now;
    if (this.filePath) this.load();
  }

  /**
   * Register (or refresh) a device. Deterministic device_id from the public key,
   * so re-pairing the same key updates rather than duplicates.
   */
  upsert(deviceId: string, publicKey: string, label: string | null = null): DeviceEntry {
    const existing = this.entries.get(deviceId);
    const entry: DeviceEntry = existing
      ? { ...existing, public_key: publicKey, label: label ?? existing.label, last_seen_at: this.now() }
      : {
          device_id: deviceId,
          public_key: publicKey,
          label,
          added_at: this.now(),
          last_seen_at: this.now(),
        };
    this.entries.set(deviceId, entry);
    this.persist();
    return entry;
  }

  get(deviceId: string): DeviceEntry | null {
    return this.entries.get(deviceId) ?? null;
  }

  has(deviceId: string): boolean {
    return this.entries.has(deviceId);
  }

  /** Remove a device. Subsequent signatures from it are rejected. Returns false if absent. */
  revoke(deviceId: string): boolean {
    const removed = this.entries.delete(deviceId);
    if (removed) this.persist();
    return removed;
  }

  list(): DeviceEntry[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }

  private load(): void {
    if (!this.filePath) return;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return; // first run — empty registry
    }
    try {
      const parsed = JSON.parse(raw) as DeviceRegistryFile;
      if (parsed?.entries && Array.isArray(parsed.entries)) {
        for (const e of parsed.entries) {
          if (e && typeof e.device_id === "string" && typeof e.public_key === "string") {
            this.entries.set(e.device_id, e);
          }
        }
      }
    } catch {
      // Corrupt file — start empty rather than crashing the gateway.
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    const payload: DeviceRegistryFile = { entries: this.list() };
    const tmp = `${this.filePath}.tmp`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }
}

// ── pairing handlers ────────────────────────────────────────────────────────

export interface PairingHandlersOptions {
  tokens: PairTokenStore;
  registry: DeviceRegistry;
  logger: Logger;
  /** Acceptable clock skew for device.resume timestamps, ms (default 60_000). */
  resumeClockSkewMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

/** Generic, non-revealing rejection so pair/resume can't act as an oracle. */
const PAIR_REJECTED = {
  kind: "error" as const,
  code: ShannonError.BAD_PARAMS,
  message: "pairing rejected (invalid token, key, or signature)",
};

export function createPairingHandlers(opts: PairingHandlersOptions): MethodHandlers {
  const skewMs = opts.resumeClockSkewMs ?? 60_000;
  const now = opts.now ?? Date.now;

  return {
    "shannon/pair": async (raw, ctx) => {
      const params = (raw ?? {}) as Partial<PairParams>;
      if (
        typeof params.pair_token !== "string" ||
        typeof params.device_public_key !== "string" ||
        typeof params.pop_signature !== "string"
      ) {
        return {
          kind: "error",
          code: ShannonError.BAD_PARAMS,
          message: "pair_token, device_public_key, pop_signature are required",
        };
      }
      // Consume FIRST (single-use, even on a failed POP — a leaked token can't
      // be retried after a bad signature attempt).
      if (!opts.tokens.consume(params.pair_token)) return PAIR_REJECTED;

      const popOk = verifyMessage(
        params.device_public_key,
        pairPopMessage(params.pair_token, params.device_public_key),
        params.pop_signature,
      );
      if (!popOk) return PAIR_REJECTED;

      const deviceId = deviceIdFromPublicKey(params.device_public_key);
      const entry = opts.registry.upsert(deviceId, params.device_public_key, params.device_label ?? null);
      bindSession(ctx, deviceId);
      opts.logger.info(`mobile device paired: ${deviceId} (${entry.label ?? "unlabeled"})`);

      const result: DeviceSessionResult = {
        device_id: deviceId,
        session_id: deviceId,
        device_label: entry.label,
      };
      return { kind: "result", result };
    },

    "shannon/device.resume": async (raw, ctx) => {
      const params = (raw ?? {}) as Partial<DeviceResumeParams>;
      if (
        typeof params.device_id !== "string" ||
        typeof params.signature !== "string" ||
        typeof params.timestamp !== "number" ||
        !Number.isFinite(params.timestamp)
      ) {
        return {
          kind: "error",
          code: ShannonError.BAD_PARAMS,
          message: "device_id, timestamp, signature are required",
        };
      }
      const entry = opts.registry.get(params.device_id);
      if (!entry) {
        return { kind: "error", code: ShannonError.PAIRING_REQUIRED, message: "device not registered" };
      }
      const age = Math.abs(now() - params.timestamp);
      if (age > skewMs) {
        return { kind: "error", code: ShannonError.BAD_PARAMS, message: "timestamp outside skew window" };
      }
      const ok = verifyMessage(
        entry.public_key,
        resumeMessage(params.device_id, params.timestamp),
        params.signature,
      );
      if (!ok) {
        return { kind: "error", code: ShannonError.BAD_PARAMS, message: "invalid device signature" };
      }
      bindSession(ctx, params.device_id);
      const result: DeviceSessionResult = { device_id: params.device_id, session_id: params.device_id };
      return { kind: "result", result };
    },
  };
}

function bindSession(ctx: MethodContext, deviceId: string): void {
  ctx.sessionId = deviceId;
}

// ── composer: pairing + engine bridge, wired with the session gate ─────────

/**
 * Signature verifier backed by the registry — used by the engine bridge to
 * check per-decision approval signatures once `requireSession` is on.
 */
export function createRegistryVerifier(registry: DeviceRegistry): DeviceSignatureVerifier {
  return (deviceId, message, signature) => {
    const entry = registry.get(deviceId);
    if (!entry) return false;
    return verifyMessage(entry.public_key, message, signature);
  };
}

export interface MobileHandlersOptions {
  /** Engine bridge config (engine URLs, model, version, test seams). */
  engine: Omit<EngineBridgeOptions, "requireSession" | "verifyDeviceSignature">;
  tokens: PairTokenStore;
  registry: DeviceRegistry;
  logger: Logger;
  resumeClockSkewMs?: number;
  now?: () => number;
}

/**
 * Build the full `shannon/*` handler map: pairing (pair/resume) + engine bridge
 * (query/cancel/approval/health/model/agent), with session-gating and mandatory
 * approval signatures enforced. This is what the gateway wires into a MobileServer
 * once P1.2 is live; tests compose it directly.
 */
export function createMobileHandlers(opts: MobileHandlersOptions): MethodHandlers {
  const pairing = createPairingHandlers({
    tokens: opts.tokens,
    registry: opts.registry,
    logger: opts.logger,
    resumeClockSkewMs: opts.resumeClockSkewMs,
    now: opts.now,
  });
  const engine = createEngineHandlers({
    ...opts.engine,
    requireSession: true,
    verifyDeviceSignature: createRegistryVerifier(opts.registry),
  });
  return { ...engine, ...pairing };
}
