import { type AdapterContext, type ChannelAdapter, type Logger } from "./adapters/types.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { EngineWsClient } from "./engine/wsClient.js";
import { SessionRouter, type EngineClientFactory } from "./router/router.js";
import { type TurnHandler } from "./router/types.js";
import { createApprovalTurnHandler } from "./router/approvalTurnHandler.js";
import { type AdapterConfig, type GatewayConfig, type LogLevel } from "./config/types.js";
import { type SecretProvider } from "./secrets/types.js";
import { createEnvSecretProvider } from "./secrets/envProvider.js";
import { createCliKeyringProvider } from "./secrets/cliKeyring.js";
import { createChainedSecretProvider } from "./secrets/chain.js";
import { createConsoleLogger } from "./logger.js";

/**
 * Turns an `AdapterConfig` + secret-backed `AdapterContext` into a live
 * `ChannelAdapter`. Each platform registers one factory; the bootstrap looks it
 * up by `config.platform`. Factories are injectable so the entry point can
 * assemble the real platform map while tests pass a mock.
 */
export type AdapterFactory = (
  cfg: AdapterConfig,
  ctx: AdapterContext,
) => ChannelAdapter | Promise<ChannelAdapter>;

export interface BootstrapOptions {
  /** platform id → factory. Real adapters register here (Slack in P1-g, others in T6). */
  factories: Map<string, AdapterFactory>;
  /** Override the engine WS client factory (tests inject a mock). */
  engineClientFactory?: EngineClientFactory;
  /** Override the turn handler (default: approval-aware, posting to engine.httpBaseUrl). */
  turnHandler?: TurnHandler;
  /** Override the secret provider (default: env → OS keyring chain). */
  secretProvider?: SecretProvider;
  /** Override the logger (default: console, level from config.logLevel). */
  logger?: Logger;
}

export interface BootstrapHandle {
  /** Stop adapters + router lanes. Idempotent. */
  stop(): Promise<void>;
  /** Number of adapters that started (diagnostics / tests). */
  readonly adapterCount: number;
}

/**
 * Wire the four layers from a `GatewayConfig`:
 *
 * 1. build the secret-backed `AdapterContext` (env → OS keyring chain),
 * 2. instantiate each enabled adapter from `factories` and register it,
 * 3. build a per-session `EngineWsClient` factory (each lane pins its own
 *    connection + `session_id`, consuming the engine's P0-d/e persistence),
 * 4. wire `adapter.onMessage → router.handleInbound`,
 * 5. `startAll` the adapters.
 *
 * The default engine client factory only *constructs* `EngineWsClient`s; the
 * lane connects them lazily on the first turn, so `bootstrap()` itself opens no
 * socket and won't fail if the engine happens to be down at startup.
 */
export async function bootstrap(
  config: GatewayConfig,
  opts: BootstrapOptions,
): Promise<BootstrapHandle> {
  const logger = opts.logger ?? createConsoleLogger((config.logLevel ?? "info") as LogLevel);
  const secretProvider =
    opts.secretProvider ??
    createChainedSecretProvider([createEnvSecretProvider(), createCliKeyringProvider()]);

  const ctx: AdapterContext = {
    logger,
    getSecret: (key: string) => secretProvider.get(key),
  };

  const registry = new AdapterRegistry();
  for (const cfg of config.adapters) {
    if (!cfg.enabled) {
      logger.info(`adapter "${cfg.platform}" disabled; skipping`);
      continue;
    }
    const factory = opts.factories.get(cfg.platform);
    if (!factory) {
      throw new Error(`no adapter factory registered for platform "${cfg.platform}"`);
    }
    const adapter = await factory(cfg, ctx);
    registry.register(adapter);
  }

  const clientFactory: EngineClientFactory =
    opts.engineClientFactory ?? ((sessionKey: string) => createEngineClient(config, sessionKey));

  const turnHandler: TurnHandler =
    opts.turnHandler ?? createApprovalTurnHandler({ engineBaseUrl: config.engine.httpBaseUrl });

  const router = new SessionRouter({ registry, clientFactory, turnHandler, logger });

  // Inbound → router. The lane serializes per session; turn errors are logged
  // in the router. onMessage is sync-void by contract, so handleInbound is
  // fire-and-forget here.
  for (const adapter of registry.all()) {
    adapter.onMessage((m) => {
      void router.handleInbound(m);
    });
  }

  await registry.startAll(ctx);
  logger.info(`shannon-gateway up: ${registry.size} adapter(s) started`);

  let stopped = false;
  return {
    get adapterCount(): number {
      return registry.size;
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await router.stop();
      await registry.stopAll();
      logger.info("shannon-gateway stopped");
    },
  };
}

function createEngineClient(config: GatewayConfig, sessionKey: string): EngineWsClient {
  return new EngineWsClient({
    url: config.engine.wsUrl,
    model: config.engine.model ?? null,
    sessionId: sessionKey,
  });
}
