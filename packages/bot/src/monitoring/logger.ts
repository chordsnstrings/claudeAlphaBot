import { pino, type Logger, type LoggerOptions } from "pino";

export interface LoggerConfig {
  readonly level: string;
  readonly format: "auto" | "pretty" | "json";
  readonly nodeEnv: string;
}

function shouldUsePretty(cfg: LoggerConfig): boolean {
  if (cfg.format === "pretty") return true;
  if (cfg.format === "json") return false;
  return cfg.nodeEnv !== "production";
}

export function buildLogger(cfg: LoggerConfig): Logger {
  const opts: LoggerOptions = {
    level: cfg.level,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['x-api-key']",
        "binance_api_key",
        "binance_api_secret",
        "apiKey",
        "apiSecret",
      ],
      censor: "[REDACTED]",
    },
  };
  if (shouldUsePretty(cfg)) {
    return pino({
      ...opts,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      },
    });
  }
  return pino(opts);
}

let singleton: Logger | null = null;

export function initLogger(cfg: LoggerConfig): Logger {
  if (singleton) return singleton;
  singleton = buildLogger(cfg);
  return singleton;
}

export function getLogger(): Logger {
  if (!singleton) {
    singleton = buildLogger({ level: "info", format: "auto", nodeEnv: "development" });
  }
  return singleton;
}
