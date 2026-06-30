/**
 * Secret provider (F14). Adapters ask for a named secret through
 * AdapterContext.getSecret; the provider reads it from the OS keyring (or env,
 * for dev). Implementations: env (dev/test), CLI keyring (prod), or a chain.
 *
 * `get` resolves `null` for a missing entry and never throws — a missing
 * secret is reported by the adapter (which knows whether it's required), not
 * by crashing the gateway.
 */
export interface SecretProvider {
  get(key: string): Promise<string | null>;
}
