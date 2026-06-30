/**
 * Wire types for the Shannon engine `api_server` WebSocket protocol.
 *
 * Mirrors `WsClientMessage` / `WsServerMessage` in
 * `shannon-code/crates/shannon-core/src/api_server.rs` field-for-field. The
 * engine serializes with `#[serde(tag = "type")]`, so every frame is
 * `{ "type": "<variant>", ...fields }` and field names are **snake_case** on
 * both sides. These types stay snake_case to match the wire 1:1 — no transform
 * layer, no drift. A normalizer (P1-d) may remap to gateway-internal shapes
 * later if a consumer wants camelCase.
 *
 * The WS Query request uses the field `prompt` (not `message`).
 */

// ── Client → engine ────────────────────────────────────────────────────

/** `query` frame sent over the socket to start a turn. */
export interface QueryRequest {
  type: "query";
  prompt: string;
  model?: string | null;
  session_id?: string | null;
}

/** `cancel` frame interrupts the in-progress query on the socket. */
export interface CancelRequest {
  type: "cancel";
}

// ── Engine → client ────────────────────────────────────────────────────

/**
 * Discriminated union of every frame the engine sends. The four terminal
 * variants end a turn's event stream.
 */
export type EngineEvent =
  | TextEvent
  | ToolUseEvent
  | ToolResultEvent
  | UsageEvent
  | CompletedEvent
  | FailedEvent
  | CancelledEvent
  | ApprovalRequestEvent
  | SessionInfoEvent
  | ErrorEvent;

export type EngineEventType = EngineEvent["type"];

/** Variants that end a turn. The engine sends exactly one per query. */
export type TerminalEngineEvent =
  | CompletedEvent
  | FailedEvent
  | CancelledEvent
  | ErrorEvent;

export const TERMINAL_EVENT_TYPES: ReadonlySet<EngineEventType> = new Set([
  "completed",
  "failed",
  "cancelled",
  "error",
]);

export function isTerminalEvent(e: EngineEvent): e is TerminalEngineEvent {
  return TERMINAL_EVENT_TYPES.has(e.type);
}

export interface TextEvent {
  type: "text";
  content: string;
}

export interface ToolUseEvent {
  type: "tool_use";
  name: string;
  input: unknown;
}

export interface ToolResultEvent {
  type: "tool_result";
  name: string;
  output: string;
}

export interface UsageEvent {
  type: "usage";
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface CompletedEvent {
  type: "completed";
  model: string;
}

export interface FailedEvent {
  type: "failed";
  error: string;
}

export interface CancelledEvent {
  type: "cancelled";
}

/**
 * Engine requests human approval for a tool call. Resolve via
 * `POST /api/approval/respond` with the matching `request_id` (wired in P1-f,
 * not this client's job).
 */
export interface ApprovalRequestEvent {
  type: "approval_request";
  request_id: string;
  tool_name: string;
  tool_input: unknown;
  description: string;
  is_destructive: boolean;
  diff_preview: string | null;
}

export interface SessionInfoEvent {
  type: "session_info";
  message_count: number;
  model: string | null;
}

export interface ErrorEvent {
  type: "error";
  message: string;
}
