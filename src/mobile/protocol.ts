/**
 * shannon/* JSON-RPC 2.0 wire protocol — the mobile↔gateway contract.
 *
 * NDJSON over WebSocket: one JSON object per line. The phone is a first-class
 * streaming client (like the desktop UI), not a throttled chat channel, so the
 * surface is the full engine event stream — this protocol is the engine WS
 * protocol's "device-friendly + E2E + rich-UI" superset (architecture doc §5.2).
 *
 * Frames:
 *  - Request       (phone→gateway):   `{ jsonrpc, id, method, params? }`
 *  - Response      (gateway→phone):   `{ jsonrpc, id, result } | { jsonrpc, id, error }`
 *  - Notification  (gateway→phone, streaming): `{ jsonrpc, method:"shannon/event", params: ShannonEvent }`
 *
 * Method names use a slashed namespace (`shannon/query`, `shannon/approval/decide`,
 * `shannon/device.resume` …) to match `shannon-mobile`'s `methods.dart`. Field
 * names are snake_case on the wire, consistent with the engine WS types.
 *
 * Source of truth: `shannon-desktop/claudedocs/mobile-host-architecture.md` §5.2.
 */

export const JSONRPC_VERSION = "2.0" as const;

/**
 * Every shannon/* method the gateway recognizes (Phase-1 minimal set, R5).
 * `shannon/pair` and `shannon/device.resume` land in P1.2 — P1.1 returns a
 * not-implemented error for them so the protocol surface is documented early.
 */
export type ShannonMethod =
  | "shannon/pair"
  | "shannon/device.resume"
  | "shannon/query"
  | "shannon/cancel"
  | "shannon/approval/decide"
  | "shannon/agent.list"
  | "shannon/agent.detail"
  | "shannon/model.list"
  | "shannon/model.switch"
  | "shannon/health";

// ── Requests (phone → gateway) ───────────────────────────────────────────

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: string | number;
  method: ShannonMethod;
  params?: P;
}

export interface QueryParams {
  prompt: string;
  model?: string | null;
  session_id?: string | null;
}

export interface CancelParams {
  session_id?: string | null;
}

export interface ApprovalDecideParams {
  request_id: string;
  /** `"allow" | "deny"` (maps to the engine `approval/respond` choice). */
  choice: "allow" | "deny";
  /** Ed25519 signature over `{request_id, choice}` — verified in P1.2. */
  signature?: string | null;
  note?: string | null;
}

export interface AgentDetailParams {
  session_id: string;
  /** Subscribe to the session's task.progress stream. */
  subscribe?: boolean;
}

/**
 * `shannon/pair` — register a device key by consuming a one-time pairToken.
 * The phone generates its own Ed25519 keypair, then proves possession of the
 * private key with `pop_signature` over `${pair_token}:${device_public_key}`
 * (see mobile/crypto.ts). On success the gateway registers the device and binds
 * the connection's session.
 */
export interface PairParams {
  pair_token: string;
  /** JWK `x` — base64url of the 32-byte Ed25519 public key. */
  device_public_key: string;
  /** Ed25519 signature over `${pair_token}:${device_public_key}`. */
  pop_signature: string;
  /** Optional human-friendly label (device name) for the paired-devices UI. */
  device_label?: string | null;
}

/**
 * `shannon/device.resume` — a previously-paired device reconnects and proves
 * identity by signing `${device_id}:${timestamp}`. The timestamp bounds replay
 * (rejected outside ±clock-skew, default 60s). On success the connection's
 * session is rebound to the device (Z1 continuity).
 */
export interface DeviceResumeParams {
  device_id: string;
  /** Epoch milliseconds; must be within the gateway's clock-skew window. */
  timestamp: number;
  /** Ed25519 signature over `${device_id}:${timestamp}`. */
  signature: string;
}

// ── Responses (gateway → phone) ──────────────────────────────────────────

export interface JsonRpcSuccess<R> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: string | number;
  result: R;
}

export interface JsonRpcError {
  jsonrpc: typeof JSONRPC_VERSION;
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse<R> = JsonRpcSuccess<R> | JsonRpcError;

// ── Notifications (gateway → phone, streaming) ───────────────────────────

/**
 * Server→phone notification carrying one event in a streaming turn. The phone
 * correlates a turn by the `query.started`/`turn_id` it sees first; subsequent
 * `task.progress` events belong to the in-flight turn on that socket.
 */
export interface ShannonEventNotification {
  jsonrpc: typeof JSONRPC_VERSION;
  method: "shannon/event";
  params: ShannonEvent;
}

export type ShannonEvent =
  | { type: "query.started"; turn_id: string }
  | { type: "task.progress"; content?: string; tool?: ToolFrame; usage?: UsageFrame }
  | { type: "query.completed"; model: string }
  | { type: "query.failed"; error: string }
  | { type: "query.cancelled" }
  | {
      type: "approval.request";
      request_id: string;
      tool_name: string;
      tool_input: unknown;
      description: string;
      is_destructive: boolean;
      diff_preview: string | null;
    };

export interface ToolFrame {
  kind: "use" | "result";
  name: string;
  input?: unknown;
  output?: string;
}

export interface UsageFrame {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

// ── Result shapes ──────────────────────────────────────────────────────────

export interface HealthResult {
  gateway: "ok";
  engine: "ok" | "down";
  version: string;
}

export interface ModelListResult {
  models: { id: string; label?: string | null }[];
  current: string | null;
}

export interface AgentListResult {
  agents: { session_id: string; platform: string; active: boolean }[];
}

/** `shannon/pair` / `shannon/device.resume` success — the connection is now bound. */
export interface DeviceSessionResult {
  /** The gateway's device id for this key (deterministic from the public key). */
  device_id: string;
  /** Bound per-connection session id; pass to subsequent methods as session_id. */
  session_id: string;
  /** Human-friendly label echoed back (pair only). */
  device_label?: string | null;
}

export interface OkResult {
  ok: true;
}

// ── Error codes ────────────────────────────────────────────────────────────

/**
 * Stable error codes. JSON-RPC reserves -32xxx for protocol errors; app errors
 * use -32xxx too where they map cleanly (method-not-found, not-implemented) and
 * the -32000 custom band for shannon-specific conditions.
 */
export const ShannonError = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  /** Method recognized but not implemented yet (e.g. pairing before P1.2). */
  NOT_IMPLEMENTED: -32603,
  /** Device must complete pairing first — the P1.2 auth gate. */
  PAIRING_REQUIRED: -32000,
  BAD_PARAMS: -32001,
  ENGINE_ERROR: -32002,
} as const;

// ── NDJSON codec ───────────────────────────────────────────────────────────

/**
 * Parse one WebSocket text frame. The mobile protocol sends one JSON object per
 * frame, but the codec tolerates newline-delimited multiples and blank lines.
 * Unparseable records yield `null` (the dispatcher reports a parse error for them).
 */
export function parseNdjson(frame: string): unknown[] {
  return frame
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    });
}

export function serializeFrame(value: unknown): string {
  return JSON.stringify(value);
}
