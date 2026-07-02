/**
 * shannon-gateway entry point.
 *
 * Loads `~/.shannon/gateway/config.json` (or `$SHANNON_GATEWAY_CONFIG`, or the
 * `--config <path>` arg), wires the four layers via `bootstrap()`, and runs
 * until SIGINT/SIGTERM.
 *
 * All eight platform adapter factories register here. The router looks them up
 * by `config.platform`; bootstrap throws at startup if an enabled platform has
 * no factory. Real-credential end-to-end smoke is a separate manual step per
 * platform (bot tokens live in the OS keyring, never in this repo).
 */
import { bootstrap, type AdapterFactory } from "./bootstrap.js";
import { loadConfig } from "./config/loader.js";
import { createConsoleLogger } from "./logger.js";

import { createSlackAdapter } from "./adapters/slack/slackAdapter.js";
import { createTelegramAdapter } from "./adapters/telegram/telegramAdapter.js";
import { createDiscordAdapter } from "./adapters/discord/discordAdapter.js";
import { createMatrixAdapter } from "./adapters/matrix/matrixAdapter.js";
import { createWhatsAppAdapter } from "./adapters/whatsapp/whatsappAdapter.js";
import { createWeComAdapter } from "./adapters/wecom/wecomAdapter.js";
import { createFeishuAdapter } from "./adapters/feishu/feishuAdapter.js";
import { createDingTalkAdapter } from "./adapters/dingtalk/dingtalkAdapter.js";

export { GATEWAY_VERSION } from "./version.js";

/** Platform id → factory. One adapter per platform; the router looks up by id. */
const factories = new Map<string, AdapterFactory>([
  ["slack", createSlackAdapter],
  ["telegram", createTelegramAdapter],
  ["discord", createDiscordAdapter],
  ["matrix", createMatrixAdapter],
  ["whatsapp", createWhatsAppAdapter],
  ["wecom", createWeComAdapter],
  ["feishu", createFeishuAdapter],
  ["dingtalk", createDingTalkAdapter],
]);

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
        "bootstrap will fail.",
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
