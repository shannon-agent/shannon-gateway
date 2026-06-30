import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { type GatewayConfig, type LogLevel } from "./types.js";

/**
 * Resolve the config path:
 * explicit arg > `$SHANNON_GATEWAY_CONFIG` > `~/.shannon/gateway/config.json`.
 */
export function resolveConfigPath(explicit?: string): string {
  if (explicit) return explicit;
  const fromEnv = process.env.SHANNON_GATEWAY_CONFIG;
  if (fromEnv) return fromEnv;
  return join(homedir(), ".shannon", "gateway", "config.json");
}

/** Load and validate a GatewayConfig from disk. Throws on missing/invalid. */
export function loadConfig(path?: string): GatewayConfig {
  const resolved = resolveConfigPath(path);
  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch (err) {
    throw new Error(
      `gateway config: cannot read ${resolved}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `gateway config: invalid JSON in ${resolved}: ${(err as Error).message}`,
    );
  }
  return validateConfig(parsed, resolved);
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/**
 * Validate an already-parsed config blob. Pure — no I/O. Exported so tests can
 * exercise validation without touching disk.
 */
export function validateConfig(parsed: unknown, path = "<inline>"): GatewayConfig {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`gateway config ${path}: expected an object`);
  }
  const obj = parsed as Record<string, unknown>;

  const engine = obj.engine;
  if (typeof engine !== "object" || engine === null) {
    throw new Error(`gateway config ${path}: missing "engine" object`);
  }
  const e = engine as Record<string, unknown>;
  if (typeof e.wsUrl !== "string" || e.wsUrl.length === 0) {
    throw new Error(`gateway config ${path}: engine.wsUrl must be a non-empty string`);
  }
  if (typeof e.httpBaseUrl !== "string" || e.httpBaseUrl.length === 0) {
    throw new Error(`gateway config ${path}: engine.httpBaseUrl must be a non-empty string`);
  }
  if (e.model !== undefined && (typeof e.model !== "string" || e.model.length === 0)) {
    throw new Error(`gateway config ${path}: engine.model must be a non-empty string if present`);
  }

  if (!Array.isArray(obj.adapters)) {
    throw new Error(`gateway config ${path}: "adapters" must be an array`);
  }
  const adapters = (obj.adapters as unknown[]).map((a, i) => {
    if (typeof a !== "object" || a === null) {
      throw new Error(`gateway config ${path}: adapters[${i}] must be an object`);
    }
    const ac = a as Record<string, unknown>;
    if (typeof ac.platform !== "string" || ac.platform.length === 0) {
      throw new Error(`gateway config ${path}: adapters[${i}].platform must be a non-empty string`);
    }
    if (typeof ac.enabled !== "boolean") {
      throw new Error(`gateway config ${path}: adapters[${i}].enabled must be boolean`);
    }
    if (ac.options !== undefined && (typeof ac.options !== "object" || ac.options === null)) {
      throw new Error(`gateway config ${path}: adapters[${i}].options must be an object`);
    }
    if (ac.secrets !== undefined && (typeof ac.secrets !== "object" || ac.secrets === null)) {
      throw new Error(`gateway config ${path}: adapters[${i}].secrets must be an object`);
    }
    const out: GatewayConfig["adapters"][number] = {
      platform: ac.platform,
      enabled: ac.enabled,
    };
    if (ac.options) out.options = ac.options as Record<string, unknown>;
    if (ac.secrets) out.secrets = ac.secrets as Record<string, string>;
    return out;
  });

  const logLevel = obj.logLevel;
  if (
    logLevel !== undefined &&
    (typeof logLevel !== "string" || !LOG_LEVELS.includes(logLevel as LogLevel))
  ) {
    throw new Error(`gateway config ${path}: logLevel must be one of debug|info|warn|error`);
  }

  const result: GatewayConfig = { engine: { wsUrl: e.wsUrl, httpBaseUrl: e.httpBaseUrl }, adapters };
  if (typeof e.model === "string" && e.model.length > 0) result.engine.model = e.model;
  if (typeof logLevel === "string") result.logLevel = logLevel as LogLevel;
  return result;
}
