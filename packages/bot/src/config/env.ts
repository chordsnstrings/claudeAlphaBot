/**
 * Environment loading + validation.
 *
 * Uses zod to enforce types and produce clear, actionable error
 * messages. Every field that can't default safely is required —
 * spec principle "fail loud, fail early". No silent fallbacks.
 */
import "dotenv/config";

import { z } from "zod";

const ModeEnum = z.enum(["backtest", "paper", "live"]);
export type EnvMode = z.infer<typeof ModeEnum>;

const BaseSchema = z.object({
  BOT_MODE: ModeEnum.default("backtest"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  LOG_FORMAT: z.enum(["auto", "pretty", "json"]).default("auto"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL must be set — refuse to connect to a default"),
  BOT_HTTP_PORT: z.coerce.number().int().positive().default(8080),
  STARTING_EQUITY_USD: z.coerce.number().positive().default(5000),
  ARTIFACT_PATH: z.string().optional(),
  BINANCE_API_KEY: z.string().optional(),
  BINANCE_API_SECRET: z.string().optional(),
  BINANCE_TESTNET: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true")
    .default("true"),
});

export type Env = z.infer<typeof BaseSchema>;

/**
 * Mode-specific requirements layered on top of the base schema.
 * This is where paper/live strictness comes in.
 */
function enforceModeRequirements(env: Env): Env {
  if (env.BOT_MODE === "paper" || env.BOT_MODE === "live") {
    if (!env.BINANCE_API_KEY || env.BINANCE_API_KEY.trim() === "") {
      throw new Error(
        `BINANCE_API_KEY is required when BOT_MODE=${env.BOT_MODE}. Set it in .env or the deploy environment.`,
      );
    }
    if (env.BOT_MODE === "live" && (!env.BINANCE_API_SECRET || env.BINANCE_API_SECRET.trim() === "")) {
      throw new Error(
        "BINANCE_API_SECRET is required when BOT_MODE=live. Set it in .env or the deploy environment.",
      );
    }
    if (!env.ARTIFACT_PATH || env.ARTIFACT_PATH.trim() === "") {
      throw new Error(
        `ARTIFACT_PATH is required when BOT_MODE=${env.BOT_MODE}. Must point to a valid validated_config.json produced by the validation pipeline.`,
      );
    }
  }
  return env;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = BaseSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return enforceModeRequirements(parsed.data);
}
