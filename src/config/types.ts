/**
 * Gateway configuration (loaded from `~/.shannon/gateway/config.json` by
 * default, or the path in `$SHANNON_GATEWAY_CONFIG`). Gateway-internal
 * camelCase.
 *
 * Secrets are NEVER inlined here — each adapter names the keyring entries it
 * needs in `secrets`, and the bootstrap reads them via the SecretProvider (F14).
 * Raw tokens never live in the repo, the config file, or process argv.
 */

export interface EngineConfig {
  /** WebSocket URL of the engine api_server, e.g. `ws://127.0.0.1:33420/api/ws`. */
  wsUrl: string;
  /** HTTP base URL for engine calls (approval respond), e.g. `http://127.0.0.1:33420`. */
  httpBaseUrl: string;
  /** Default model for queries that don't specify one. */
  model?: string;
}

export interface AdapterConfig {
  /** Platform id matching a registered adapter factory (e.g. "slack"). */
  platform: string;
  enabled: boolean;
  /**
   * Platform-specific NON-SECRET options, opaque to the gateway core. The
   * adapter factory reads what it needs (app id, team id, webhook path, ...).
   * Tokens go in `secrets`, never here.
   */
  options?: Record<string, unknown>;
  /**
   * Named OS-keyring entries the adapter needs. Map of adapter-internal name →
   * keyring key, e.g. `{ botToken: "slack/bot-token" }`.
   */
  secrets?: Record<string, string>;
}

export interface GatewayConfig {
  engine: EngineConfig;
  adapters: AdapterConfig[];
  /** Log level. Default "info". */
  logLevel?: LogLevel;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
