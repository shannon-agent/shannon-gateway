import {
  type AdapterCapabilities,
  type ChannelAdapter,
  type Platform,
  PLATFORMS,
} from "./types.js";

/**
 * Validate that an object satisfies the structural ChannelAdapter contract.
 *
 * This is the reusable primitive behind the design doc's "契约测试框架":
 * `registry.register` runs it to reject malformed adapters at registration
 * (fail fast), and each real adapter's contract test can call it on a
 * fully-wired instance. Static-shape only — behavioral contract assertions
 * (send→receipt, onMessage delivery) ship with each adapter.
 */
export function assertAdapterContract(adapter: unknown): asserts adapter is ChannelAdapter {
  if (typeof adapter !== "object" || adapter === null) {
    throw new ContractError(`adapter must be an object, got ${typeof adapter}`);
  }
  const a = adapter as Record<string, unknown>;

  if (!isPlatform(a.platform)) {
    throw new ContractError(
      `adapter.platform must be one of ${PLATFORMS.join("|")}, got ${String(a.platform)}`,
    );
  }

  assertCapabilities(a.capabilities);

  const fns: (keyof ChannelAdapter)[] = [
    "start",
    "stop",
    "onMessage",
    "send",
    "requestApproval",
    "resolveSessionConversation",
  ];
  for (const name of fns) {
    if (typeof a[name] !== "function") {
      throw new ContractError(`adapter.${String(name)} must be a function`);
    }
  }
}

function assertCapabilities(c: unknown): asserts c is AdapterCapabilities {
  if (typeof c !== "object" || c === null) {
    throw new ContractError("adapter.capabilities must be an object");
  }
  const caps = c as Record<string, unknown>;
  for (const key of ["threading", "pairing", "approvalButtons"] as const) {
    if (typeof caps[key] !== "boolean") {
      throw new ContractError(`capabilities.${key} must be boolean`);
    }
  }
  if (
    caps.streaming !== "none" &&
    caps.streaming !== "partial" &&
    caps.streaming !== "block"
  ) {
    throw new ContractError(
      `capabilities.streaming must be "none"|"partial"|"block", got ${String(caps.streaming)}`,
    );
  }
}

function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}

export class ContractError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}
