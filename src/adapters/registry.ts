import { type AdapterContext, type ChannelAdapter, type Platform } from "./types.js";
import { assertAdapterContract } from "./contract.js";

/**
 * Platform-keyed registry of transport adapters (layer 1).
 *
 * The router (P1-c) and the engine client are platform-agnostic; they look up
 * the right adapter here by ReplyTarget.platform / NormalizedInbound.platform.
 * Registration runs `assertAdapterContract` so a malformed adapter fails at
 * registration, not on first use.
 *
 * One adapter per platform. Two adapters for the same platform would race on
 * inbound sockets and confuse routing — register() rejects duplicates.
 */
export class AdapterRegistry {
  private readonly byPlatform = new Map<Platform, ChannelAdapter>();

  /** Register an adapter. Throws on duplicate platform or contract violation. */
  register(adapter: ChannelAdapter): void {
    assertAdapterContract(adapter);
    if (this.byPlatform.has(adapter.platform)) {
      throw new Error(`adapter already registered for platform "${adapter.platform}"`);
    }
    this.byPlatform.set(adapter.platform, adapter);
  }

  get(platform: Platform): ChannelAdapter | undefined {
    return this.byPlatform.get(platform);
  }

  /** All registered adapters, in insertion order. */
  all(): ChannelAdapter[] {
    return [...this.byPlatform.values()];
  }

  get size(): number {
    return this.byPlatform.size;
  }

  /** Start every registered adapter with a shared context. */
  async startAll(ctx: AdapterContext): Promise<void> {
    await Promise.all([...this.byPlatform.values()].map((a) => a.start(ctx)));
  }

  /** Stop every registered adapter. Best-effort: one failure won't skip the rest. */
  async stopAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.byPlatform.values()].map((a) => a.stop()),
    );
    const firstError = results.find(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (firstError) {
      throw firstError.reason instanceof Error
        ? firstError.reason
        : new Error(String(firstError.reason));
    }
  }
}
