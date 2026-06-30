/**
 * shannon-gateway entry point.
 *
 * Loads `~/.shannon/gateway/config.json` (or `$SHANNON_GATEWAY_CONFIG`, or the
 * `--config <path>` arg), wires the four layers via `bootstrap()`, and runs
 * until SIGINT/SIGTERM.
 *
 * Platform adapter factories register here. Phase 1 ships the engine-client →
 * router → approval loop, mock-tested end-to-end; real platform adapters
 * (Slack in P1-g, Telegram/Discord/Matrix/WhatsApp/WeCom/Feishu/DingTalk in T6)
 * drop in by importing a factory and adding it to the `factories` map.
 */
import { bootstrap, type AdapterFactory } from "./bootstrap.js";
import { loadConfig } from "./config/loader.js";
import { createConsoleLogger } from "./logger.js";

export const GATEWAY_VERSION = "0.1.0";

// Real adapter factories are imported and registered here as they land.
// (Phase 1 completes the loop with mock-tested adapters; real ones need their
// platform credentials supplied via the OS keyring, not committed here.)
const factories = new Map<string, AdapterFactory>();
// factories.set("slack", createSlackAdapter);   // P1-g — needs real bot token

async function main(): Promise<void> {
  const logger = createConsoleLogger("info");

  let configPath: string | undefined;
  const arg = process.argv[2];
  if (arg === "--config" && typeof process.argv[3] === "string") {
    configPath = process.argv[3];
  }

  const config = loadConfig(configPath);

  if (factories.size === 0 && config.adapters.some((a) => a.enabled)) {
    logger.warn(
      "no platform adapter factories are registered but the config enables adapters; " +
        "bootstrap will fail. Register real adapters (P1-g / T6).",
    );
  }

  const handle = await bootstrap(config, { factories });

  const shutdown = async (sig: string): Promise<void> => {
    logger.info(`received ${sig}; shutting down`);
    try {
      await handle.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error("shannon-gateway failed to start:", err);
    process.exit(1);
  });
}

export { main };
