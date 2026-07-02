/**
 * Single source of truth for the gateway version. Lives in its own module so
 * both the entry point (`index.ts`, re-exports) and `bootstrap.ts` (surfaces it
 * via `shannon/health`) can import it without a circular dependency.
 *
 * Keep in sync with `package.json` `version` on release.
 */
export const GATEWAY_VERSION = "0.1.0";
