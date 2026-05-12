import { pino, type Logger, type LoggerOptions } from "pino";

const DEFAULT_LEVEL = "info";

let cachedRoot: Logger | null = null;

function buildOptions(): LoggerOptions {
  const envLevel = process.env["LOG_LEVEL"];
  return {
    level: envLevel && envLevel.length > 0 ? envLevel : DEFAULT_LEVEL,
    // Structured JSON; no pretty-printing transport — let downstream tooling
    // consume the JSON lines directly.
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      service: "trading-system",
      pid: process.pid,
    },
  };
}

/** Return the cached root logger; creates it on first call. */
export function getLogger(): Logger {
  if (cachedRoot === null) {
    cachedRoot = pino(buildOptions());
  }
  return cachedRoot;
}

/** Convenience: a child logger bound to a component name. */
export function logger(component: string): Logger {
  return getLogger().child({ component });
}

/** Test hook: force a fresh logger (e.g., after mutating LOG_LEVEL). */
export function resetLoggerForTest(): void {
  cachedRoot = null;
}
