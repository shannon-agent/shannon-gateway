import {
  type Logger,
  type NormalizedInbound,
  type ReplyTarget,
} from "../adapters/types.js";
import { type AdapterRegistry } from "../adapters/registry.js";
import { type EngineWsClient } from "../engine/wsClient.js";
import { SessionLane } from "./lane.js";
import { sessionKeyOf } from "./sessionKey.js";
import { type TurnHandler } from "./types.js";

/**
 * Builds and owns per-session EngineWsClients. The factory receives the
 * session key so it can pin a stable `session_id` for the engine.
 */
export type EngineClientFactory = (sessionKey: string) => EngineWsClient;

/**
 * Routes NormalizedInbound to a per-session lane (layer 3). Same session key
 * → serialized turns (F5); different keys → parallel lanes.
 *
 * Wiring: the host calls `adapter.onMessage(router.handleInbound)` after
 * register+start. Each inbound is keyed, routed to its lane, and the lane's
 * turn handler runs inside the serial queue with a connected engine client
 * scoped to that session.
 */
export class SessionRouter {
  private readonly lanes = new Map<string, SessionLane>();
  private readonly logger: Logger;
  private readonly registry: AdapterRegistry;
  private readonly clientFactory: EngineClientFactory;
  private readonly turnHandler: TurnHandler;

  constructor(opts: {
    registry: AdapterRegistry;
    clientFactory: EngineClientFactory;
    turnHandler: TurnHandler;
    logger: Logger;
  }) {
    this.registry = opts.registry;
    this.clientFactory = opts.clientFactory;
    this.turnHandler = opts.turnHandler;
    this.logger = opts.logger;
  }

  /**
   * Inbound entry point. Looks up the adapter, keys the session, ensures a
   * lane exists, and enqueues the turn. Returns a promise that resolves when
   * this turn completes (or rejects if the turn handler throws — the lane
   * itself stays healthy for the next turn).
   */
  handleInbound(inbound: NormalizedInbound): Promise<void> {
    const adapter = this.registry.get(inbound.platform);
    if (!adapter) {
      this.logger.warn(
        `inbound from unregistered platform "${inbound.platform}"; dropping`,
      );
      return Promise.resolve();
    }

    const key = sessionKeyOf(inbound, adapter);
    const lane = this.ensureLane(key);
    const replyTarget: ReplyTarget = {
      platform: inbound.platform,
      chatId: inbound.chatId,
      threadId: inbound.threadId,
    };

    return lane.enqueue(async () => {
      const client = await lane.getClient();
      try {
        await this.turnHandler.handle({
          inbound,
          client,
          replyTarget,
          adapter,
          logger: this.logger,
        });
      } catch (err) {
        this.logger.error(
          `turn failed in lane ${key}: ${(err as Error).message}`,
        );
        throw err;
      }
    });
  }

  private ensureLane(key: string): SessionLane {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = new SessionLane(key, () => this.clientFactory(key), this.logger);
      this.lanes.set(key, lane);
    }
    return lane;
  }

  /** Stop every lane's engine client and drop the lanes. */
  async stop(): Promise<void> {
    const lanes = [...this.lanes.values()];
    this.lanes.clear();
    await Promise.all(lanes.map((l) => l.stop()));
  }

  /** Number of active lanes (diagnostics / tests). */
  get laneCount(): number {
    return this.lanes.size;
  }
}
