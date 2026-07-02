import { homedir } from "node:os";
import { join } from "node:path";

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
import { GATEWAY_VERSION } from "./version.js";
import { MobileServer } from "./mobile/server.js";
import {
  createMobileHandlers,
  DeviceRegistry,
  PairTokenStore,
} from "./mobile/pairing.js";
import type { EngineClientFactory as MobileEngineClientFactory } from "./mobile/engineBridge.js";

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
  /**
   * Mobile server test seams (only used when `config.mobile.enabled`). The
   * engine-client factory lets tests stub the query stream; `fetchImpl` stubs
   * the engine health/approval HTTP calls. Both optional in production.
   */
  mobileEngineClientFactory?: MobileEngineClientFactory;
  mobileFetchImpl?: typeof fetch;
}

export interface BootstrapHandle {
  /** Stop adapters + router lanes + mobile server. Idempotent. */
  stop(): Promise<void>;
  /** Number of adapters that started (diagnostics / tests). */
  readonly adapterCount: number;
  /** Bound mobile server port, or `null` when the mobile server is disabled. */
  readonly mobilePort: number | null;
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

  const mobile = config.mobile?.enabled
    ? await startMobileServer(config, logger, opts)
    : null;
  if (mobile) {
    logger.info(
      `mobile shannon/* server listening on ${config.mobile?.host ?? "127.0.0.1"}:${mobile.port}`,
    );
  }

  let stopped = false;
  return {
    get adapterCount(): number {
      return registry.size;
    },
    get mobilePort(): number | null {
      return mobile?.port ?? null;
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await mobile?.handle.stop().catch(() => {});
      await router.stop();
      await registry.stopAll();
      logger.info("shannon-gateway stopped");
    },
  };
}

/**
 * Start the inbound mobile `shannon/*` server (Option B adapter, P1.1–P1.3).
 *
 * Design D control channel: pairing state is shared via files — the desktop
 * appends one-time tokens to `tokensFile` (consumed here on `shannon/pair`) and
 * both processes read/write the device registry at `devicesFile`. The engine
 * bridge enforces `requireSession` (query/cancel/approval are gated behind a
 * paired device) and mandates an Ed25519 signature on every approval decision.
 */
async function startMobileServer(
  config: GatewayConfig,
  logger: Logger,
  opts: BootstrapOptions,
): Promise<{ handle: { stop(): Promise<void> }; port: number }> {
  const mobileCfg = config.mobile!;
  const host = mobileCfg.host ?? "127.0.0.1";
  const port = mobileCfg.port ?? 33430;
  const tokensFile = mobileCfg.tokensFile ?? join(homedir(), ".shannon", "mobile-pair-tokens.jsonl");
  const devicesFile = mobileCfg.devicesFile ?? join(homedir(), ".shannon", "mobile-devices.json");

  const tokens = new PairTokenStore({ filePath: tokensFile });
  const registry = new DeviceRegistry({ filePath: devicesFile });
  const handlers = createMobileHandlers({
    engine: {
      engineWsUrl: config.engine.wsUrl,
      engineHttpBaseUrl: config.engine.httpBaseUrl,
      defaultModel: config.engine.model ?? null,
      version: GATEWAY_VERSION,
      logger,
      engineClientFactory: opts.mobileEngineClientFactory,
      fetchImpl: opts.mobileFetchImpl,
    },
    tokens,
    registry,
    logger,
  });

  const server = new MobileServer({ host, port, logger, handlers });
  const handle = await server.start();
  return { handle, port: handle.port };
}

function createEngineClient(config: GatewayConfig, sessionKey: string): EngineWsClient {
  return new EngineWsClient({
    url: config.engine.wsUrl,
    model: config.engine.model ?? null,
    sessionId: sessionKey,
  });
}
