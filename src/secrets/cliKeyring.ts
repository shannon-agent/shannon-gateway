import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";

import { type SecretProvider } from "./types.js";

const pexec = promisify(execFile);

/** Injectable exec so tests don't shell out to a real OS keyring. */
export type ExecFn = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

/**
 * OS keyring via the platform CLI (no native dep — keeps the bundle simple for
 * the single-binary P2 target).
 *
 * - macOS:  `security find-generic-password -s <service> -a <account> -w`
 * - Linux:  `secret-tool lookup service <service> account <account>` (libsecret)
 * - Windows / others: not supported via CLI here — fall through to env or a
 *   future desktop-managed keyring.
 *
 * Key format: `"<service>/<account>"`. With no `/`, `service` defaults to
 * `shannon-gateway` and the whole key is the account.
 *
 * Resolves `null` (never throws) if the tool is missing or the entry isn't
 * found, so a missing secret doesn't crash the gateway.
 */
export function createCliKeyringProvider(
  opts: { service?: string; exec?: ExecFn } = {},
): SecretProvider {
  const defaultService = opts.service ?? "shannon-gateway";
  const exec = opts.exec ?? defaultExec;
  return {
    async get(key: string): Promise<string | null> {
      const { service, account } = splitKey(key, defaultService);
      const [cmd, args] = commandFor(service, account);
      if (cmd === null) return null; // unsupported platform
      try {
        const out = await exec(cmd, args);
        const v = out.stdout.trim();
        return v.length > 0 ? v : null;
      } catch {
        return null;
      }
    },
  };
}

function splitKey(
  key: string,
  defaultService: string,
): { service: string; account: string } {
  const idx = key.indexOf("/");
  if (idx < 0) return { service: defaultService, account: key };
  return { service: key.slice(0, idx), account: key.slice(idx + 1) };
}

/** Returns `[null, []]` on unsupported platforms so the provider falls through. */
function commandFor(service: string, account: string): [string | null, string[]] {
  switch (platform()) {
    case "darwin":
      return ["security", ["find-generic-password", "-s", service, "-a", account, "-w"]];
    case "linux":
      return ["secret-tool", ["lookup", "service", service, "account", account]];
    default:
      return [null, []];
  }
}

async function defaultExec(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return pexec(cmd, args);
}
