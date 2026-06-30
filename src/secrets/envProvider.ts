import { type SecretProvider } from "./types.js";

/**
 * Key mapping: `"slack/bot-token"` → env `SHANNON_SECRET__SLACK_BOT_TOKEN`
 * (non-alphanumeric → `_`, uppercased, `SHANNON_SECRET__` prefix). Dev/testing
 * escape hatch — real deployments read from the OS keyring instead.
 */
export function envNameForKey(key: string): string {
  return "SHANNON_SECRET__" + key.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/** Reads secrets from a process.env-like map (defaults to `process.env`). */
export function createEnvSecretProvider(
  env: Record<string, string | undefined> = process.env,
): SecretProvider {
  return {
    async get(key: string): Promise<string | null> {
      const v = env[envNameForKey(key)];
      return v && v.length > 0 ? v : null;
    },
  };
}
