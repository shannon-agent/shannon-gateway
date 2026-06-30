import { type Logger } from "./adapters/types.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Minimal console Logger. Adapters and the router depend only on the `Logger`
 * interface (src/adapters/types.ts), so tests inject a noop/logger and
 * production wires this one. `level` filters debug/info; warn/error always show.
 */
export function createConsoleLogger(level: LogLevel = "info"): Logger {
  const min = ORDER[level];
  return {
    debug: (m, ...a) => {
      if (ORDER.debug >= min) console.debug(m, ...a);
    },
    info: (m, ...a) => {
      if (ORDER.info >= min) console.info(m, ...a);
    },
    warn: (m, ...a) => {
      if (ORDER.warn >= min) console.warn(m, ...a);
    },
    error: (m, ...a) => {
      if (ORDER.error >= min) console.error(m, ...a);
    },
  };
}
