import { type SecretProvider } from "./types.js";

/**
 * Try each provider in order; first non-empty value wins. Used to layer
 * env (dev) over OS keyring (prod), so a token in `$SHANNON_SECRET__…` wins
 * over the keyring entry of the same name during local development.
 */
export function createChainedSecretProvider(
  providers: readonly SecretProvider[],
): SecretProvider {
  return {
    async get(key: string): Promise<string | null> {
      for (const p of providers) {
        const v = await p.get(key);
        if (v && v.length > 0) return v;
      }
      return null;
    },
  };
}
