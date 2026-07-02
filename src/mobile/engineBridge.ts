/**
 * P1.1b engine bridge: binds the `shannon/*` method surface (P1.1a) to the real
 * Shannon engine. The MobileServer owns transport; this module owns semantics.
 *
 *   shannon/query           → engine WS Query (streaming EngineEvent → ShannonEvent)
 *   shannon/cancel          → engine WS cancel on the in-flight client
 *   shannon/approval/decide → engine HTTP POST /api/approval/respond
 *   shannon/health          → probe engine HTTP liveness
 *   shannon/model.list      → configured/switched default (minimal; real discovery later)
 *   shannon/model.switch    → override default model for subsequent queries
 *   shannon/agent.list      → [] stub (P1.x wires real session enumeration)
 *   shannon/agent.detail    → NOT_IMPLEMENTED (session-watch is a later phase)
 *   shannon/pair            → NOT_IMPLEMENTED (P1.2: Ed25519 pairing + OS keyring)
 *   shannon/device.resume   → NOT_IMPLEMENTED (P1.2)
 *
 * The phone is a first-class streaming client (architecture doc §5.2): the full
 * engine event stream is forwarded as `shannon/event` notifications, mapped to
 * the mobile-friendly ShannonEvent union by `mapEngineEvent`.
 *
 * Active-query tracking: one EngineClient per query, keyed by session_id (or
 * "__anon__" when none) so `shannon/cancel` can find and interrupt it. P1.2's
 * device pairing replaces the anon key with a stable device session id, and
 * verifies the Ed25519 signature on every approval decision.
 */

import { respondToApproval, type GatewayApprovalChoice } from "../engine/httpClient.js";
import { EngineWsClient, type EngineWsClientOptions } from "../engine/wsClient.js";
import type { EngineEvent } from "../engine/types.js";
import type { Logger } from "../adapters/types.js";
import {
  ShannonError,
  type AgentListResult,
  type ApprovalDecideParams,
  type CancelParams,
  type HealthResult,
  type ModelListResult,
  type OkResult,
  type QueryParams,
  type ShannonEvent,
} from "./protocol.js";
import type { MethodHandlers } from "./server.js";

/**
 * The engine-client surface this bridge consumes. `EngineWsClient` satisfies it;
 * tests pass a fake. Parameterized so the bridge never imports a concrete socket
 * implementation except as the default factory.
 */
export interface EngineClient {
  connect(): Promise<void>;
  runQuery(
    prompt: string,
    opts?: { model?: string | null; sessionId?: string | null },
  ): AsyncIterable<EngineEvent>;
  cancel(): void;
  close(): Promise<void>;
}

export type EngineClientFactory = (opts: EngineWsClientOptions) => EngineClient;

export interface EngineBridgeOptions {
  /** Engine WS URL, e.g. `ws://127.0.0.1:33420/api/ws`. */
  engineWsUrl: string;
  /** Engine HTTP base URL, e.g. `http://127.0.0.1:33420` (approval POST + health). */
  engineHttpBaseUrl: string;
  /** Default model when neither the request nor a `model.switch` override sets one. */
  defaultModel?: string | null;
  /** Gateway version, surfaced in `shannon/health`. */
  version: string;
  logger: Logger;
  /** Test seam: override EngineClient construction. */
  engineClientFactory?: EngineClientFactory;
  /** Test seam for the health probe + approval POST (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

/** Sentinel key for queries without a session_id (P1.2 replaces it with a device id). */
const ANON_KEY = "__anon__";

/**
 * Build the `MethodHandlers` map that wires `shannon/*` to the engine. Stateful
 * (tracks in-flight queries for cancel + the model.switch override) but stateless
 * across restarts — P1.2 adds persistent device/session binding.
 */
export function createEngineHandlers(opts: EngineBridgeOptions): MethodHandlers {
  const factory: EngineClientFactory =
    opts.engineClientFactory ?? ((o) => new EngineWsClient(o));
  const fetchImpl = opts.fetchImpl ?? fetch;

  /** session key → in-flight client (for cancel). One query per key at a time. */
  const activeQueries = new Map<string, EngineClient>();
  let modelOverride: string | null = null;

  return {
    // ── streaming query ───────────────────────────────────────────────────
    "shannon/query": async (raw) => {
      const params = (raw ?? {}) as Partial<QueryParams>;
      if (typeof params.prompt !== "string" || params.prompt.trim().length === 0) {
        return {
          kind: "error",
          code: ShannonError.BAD_PARAMS,
          message: "params.prompt (non-empty string) is required",
        };
      }
      const sessionId = params.session_id ?? null;
      const model = params.model ?? modelOverride ?? opts.defaultModel ?? null;
      const key = sessionId ?? ANON_KEY;

      // If a previous query on this key never reached a terminal event (e.g. the
      // phone reopened the socket), tear its client down before starting fresh.
      const prior = activeQueries.get(key);
      if (prior) {
        opts.logger.warn(`shannon/query: replacing in-flight client for key=${key}`);
        activeQueries.delete(key);
        await prior.close().catch(() => {});
      }

      const client = factory({ url: opts.engineWsUrl, model, sessionId });
      try {
        await client.connect();
      } catch (err) {
        return {
          kind: "error",
          code: ShannonError.ENGINE_ERROR,
          message: `engine connect failed: ${(err as Error).message}`,
        };
      }
      activeQueries.set(key, client);

      const turnId = crypto.randomUUID();
      const stream = (async function* (): AsyncGenerator<ShannonEvent> {
        yield { type: "query.started", turn_id: turnId };
        try {
          for await (const ev of client.runQuery(params.prompt as string, { model, sessionId })) {
            const mapped = mapEngineEvent(ev);
            if (mapped) yield mapped;
          }
        } finally {
          activeQueries.delete(key);
          await client.close().catch(() => {});
        }
      })();

      return { kind: "stream", stream, result: { ok: true } satisfies OkResult };
    },

    // ── cancel ────────────────────────────────────────────────────────────
    "shannon/cancel": async (raw) => {
      const params = (raw ?? {}) as Partial<CancelParams>;
      const key = params.session_id ?? ANON_KEY;
      const client = activeQueries.get(key);
      if (client) {
        client.cancel();
      } else {
        // Idempotent: a cancel for nothing-in-flight is a no-op success, matching
        // the engine's own cancel semantics.
        opts.logger.info(`shannon/cancel: no in-flight query for key=${key} (no-op)`);
      }
      return { kind: "result", result: { ok: true } satisfies OkResult };
    },

    // ── approval decision ─────────────────────────────────────────────────
    "shannon/approval/decide": async (raw) => {
      const params = (raw ?? {}) as Partial<ApprovalDecideParams>;
      if (typeof params.request_id !== "string" || params.request_id.length === 0) {
        return {
          kind: "error",
          code: ShannonError.BAD_PARAMS,
          message: "params.request_id is required",
        };
      }
      if (params.choice !== "allow" && params.choice !== "deny") {
        return {
          kind: "error",
          code: ShannonError.BAD_PARAMS,
          message: 'params.choice must be "allow" or "deny"',
        };
      }
      // P1.2 verifies the Ed25519 signature over {request_id, choice} here and
      // rejects unsigned decisions. P1.1b trusts the gateway's local socket —
      // the server is not network-exposed until P1.2 pairing is in place.
      if (!params.signature) {
        opts.logger.warn(
          "shannon/approval/decide: missing signature (P1.2 will enforce Ed25519)",
        );
      }
      try {
        await respondToApproval({
          engineBaseUrl: opts.engineHttpBaseUrl,
          requestId: params.request_id,
          choice: params.choice as GatewayApprovalChoice,
          fetchImpl,
        });
      } catch (err) {
        return {
          kind: "error",
          code: ShannonError.ENGINE_ERROR,
          message: (err as Error).message,
        };
      }
      return { kind: "result", result: { ok: true } satisfies OkResult };
    },

    // ── health ────────────────────────────────────────────────────────────
    "shannon/health": async () => {
      const engine = await probeEngineHttp(opts.engineHttpBaseUrl, fetchImpl);
      return {
        kind: "result",
        result: { gateway: "ok", engine, version: opts.version } satisfies HealthResult,
      };
    },

    // ── models (minimal; real discovery is a later phase) ─────────────────
    "shannon/model.list": async () => {
      const current = modelOverride ?? opts.defaultModel ?? null;
      const models = current ? [{ id: current }] : [];
      return { kind: "result", result: { models, current } satisfies ModelListResult };
    },

    "shannon/model.switch": async (raw) => {
      const params = (raw ?? {}) as { model?: unknown };
      if (typeof params.model !== "string" || params.model.trim().length === 0) {
        return {
          kind: "error",
          code: ShannonError.BAD_PARAMS,
          message: "params.model (non-empty string) is required",
        };
      }
      modelOverride = params.model;
      return { kind: "result", result: { ok: true } satisfies OkResult };
    },

    // ── agents (stub surface; P1.x wires enumeration) ─────────────────────
    "shannon/agent.list": async () => {
      // P1.x: enumerate the host's active sessions from the engine. P1.1b returns
      // an empty roster so the phone UI can ship against a stable shape.
      return { kind: "result", result: { agents: [] } satisfies AgentListResult };
    },

    "shannon/agent.detail": async () => ({
      kind: "error",
      code: ShannonError.NOT_IMPLEMENTED,
      message: "shannon/agent.detail (session watch) is not implemented in P1.1b",
    }),

    // ── pairing (P1.2) ────────────────────────────────────────────────────
    "shannon/pair": async () => ({
      kind: "error",
      code: ShannonError.NOT_IMPLEMENTED,
      message: "shannon/pair lands in P1.2 (Ed25519 pairing + OS keyring)",
    }),

    "shannon/device.resume": async () => ({
      kind: "error",
      code: ShannonError.NOT_IMPLEMENTED,
      message: "shannon/device.resume lands in P1.2",
    }),
  };
}

/**
 * Translate one engine WS event into a mobile-facing ShannonEvent. Returns null
 * for events with no phone-facing representation (currently `session_info`, which
 * is metadata-only). Pure + exported so the mapping is unit-testable in isolation
 * and stays the single source of truth for engine→mobile semantics.
 */
export function mapEngineEvent(ev: EngineEvent): ShannonEvent | null {
  switch (ev.type) {
    case "text":
      return { type: "task.progress", content: ev.content };
    case "tool_use":
      return {
        type: "task.progress",
        tool: { kind: "use", name: ev.name, input: ev.input },
      };
    case "tool_result":
      return {
        type: "task.progress",
        tool: { kind: "result", name: ev.name, output: ev.output },
      };
    case "usage":
      return {
        type: "task.progress",
        usage: {
          input_tokens: ev.input_tokens,
          output_tokens: ev.output_tokens,
          cost_usd: ev.cost_usd,
        },
      };
    case "completed":
      return { type: "query.completed", model: ev.model };
    case "failed":
      return { type: "query.failed", error: ev.error };
    case "cancelled":
      return { type: "query.cancelled" };
    case "approval_request":
      return {
        type: "approval.request",
        request_id: ev.request_id,
        tool_name: ev.tool_name,
        tool_input: ev.tool_input,
        description: ev.description,
        is_destructive: ev.is_destructive,
        diff_preview: ev.diff_preview,
      };
    case "session_info":
      // Metadata-only; no mobile-facing event. (Usage/cost for the turn already
      // arrives via the `usage` event, so nothing is lost.)
      return null;
    case "error":
      return { type: "query.failed", error: ev.message };
    default: {
      // Exhaustiveness guard — if EngineEvent gains a variant, this errors at
      // compile time, forcing mapEngineEvent to handle it.
      const _exhaustive: never = ev;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Liveness probe via HTTP rather than WS: the P0.2 engine gates the WS route
 * behind a bearer token, so an unauthenticated WS handshake would 401 and look
 * "down" even when the engine is healthy. Any HTTP response (200/401/404) means
 * the server is up; only connection refusal or timeout means down.
 */
async function probeEngineHttp(
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs = 2000,
): Promise<"ok" | "down"> {
  try {
    const res = await fetchImpl(baseUrl, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 5xx means the server reached us but is itself failing; treat as down so the
    // phone surfaces a real degradation rather than a silent "ok".
    return res.status < 500 ? "ok" : "down";
  } catch {
    return "down";
  }
}
