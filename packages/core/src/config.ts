/**
 * Zod-validated environment configuration loaded on startup.
 *
 * Returns an {@link EnvConfig} — the env-derived foundation. The engine
 * takes a richer runtime {@link SystemConfig} (defined in types/) that
 * extends this with the strategies, riskConfig and orchestratorMode that
 * don't fit cleanly in env vars; `resolveSystemConfig()` composes the two.
 *
 * Mode-conditional: when MODE=backtest the BACKTEST_* fields are required
 * and CTRADER_* are ignored; when MODE=live the CTRADER_* fields are
 * required (modulo OAuth tokens which are populated in Phase 18).
 *
 * Spec: trading_system_docs.md section 4.4.
 */

import { z } from "zod";

// ---- Primitive helpers -----------------------------------------------------

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "expected YYYY-MM-DD");

const portNumber = z.coerce.number().int().positive().max(65535);
const positiveInt = z.coerce.number().int().positive();
const positiveNumber = z.coerce.number().positive();
const bigintCoerce = z.coerce.bigint();

// ---- Top-level shape -------------------------------------------------------

const NodeEnv = z.enum(["development", "test", "production"]);
const LogLevel = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
const Mode = z.enum(["backtest", "live"]);

const baseShape = z.object({
  NODE_ENV: NodeEnv.default("development"),
  LOG_LEVEL: LogLevel.default("info"),
  MODE: Mode,

  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .startsWith("postgres://", "DATABASE_URL must use the postgres:// scheme"),
  DATABASE_POOL_SIZE: positiveInt.default(10),

  HTTP_PORT: portNumber.default(3000),
  HTTP_HOST: z.string().min(1).default("0.0.0.0"),
});

const backtestShape = z.object({
  BACKTEST_START_DATE: dateString,
  BACKTEST_END_DATE: dateString,
  BACKTEST_INITIAL_EQUITY_USD: positiveNumber,
  BACKTEST_FRICTION_PROFILE: z
    .enum(["pepperstone_razor", "pepperstone_standard", "zero_friction"])
    .default("pepperstone_razor"),
  BACKTEST_RANDOM_SEED: bigintCoerce.default(BigInt(42) as unknown as bigint),
});

const liveShape = z.object({
  CTRADER_CLIENT_ID: z.string().min(1, "CTRADER_CLIENT_ID is required in live mode"),
  CTRADER_CLIENT_SECRET: z.string().min(1, "CTRADER_CLIENT_SECRET is required in live mode"),
  CTRADER_ACCOUNT_ID: z.string().min(1, "CTRADER_ACCOUNT_ID is required in live mode"),
  CTRADER_ACCOUNT_TYPE: z.enum(["demo", "live"]),
  // Tokens are populated by the Phase 18 OAuth flow. Allow empty pre-Phase-18.
  CTRADER_ACCESS_TOKEN: z.string().optional().default(""),
  CTRADER_REFRESH_TOKEN: z.string().optional().default(""),
  CTRADER_REDIRECT_URL: z.string().url(),
});

// ---- Discriminated config types -------------------------------------------

export type BacktestEnvConfig = z.infer<typeof backtestShape>;
export type LiveEnvConfig = z.infer<typeof liveShape>;
export type BaseEnvConfig = z.infer<typeof baseShape>;

export type EnvConfig =
  | (BaseEnvConfig & { MODE: "backtest"; backtest: BacktestEnvConfig; live: null })
  | (BaseEnvConfig & { MODE: "live"; live: LiveEnvConfig; backtest: null });

// ---- Loader ---------------------------------------------------------------

/**
 * Load + validate config from `process.env` (or a supplied record). Throws
 * a {@link ConfigValidationError} with a human-friendly message on failure.
 */
export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const base = parseOrThrow("base", baseShape, env);

  if (base.MODE === "backtest") {
    const backtest = parseOrThrow("backtest", backtestShape, env);
    if (backtest.BACKTEST_START_DATE > backtest.BACKTEST_END_DATE) {
      throw new ConfigValidationError(
        `BACKTEST_START_DATE (${backtest.BACKTEST_START_DATE}) must be ` +
          `<= BACKTEST_END_DATE (${backtest.BACKTEST_END_DATE})`,
      );
    }
    return { ...base, MODE: "backtest", backtest, live: null };
  }

  const live = parseOrThrow("live", liveShape, env);
  return { ...base, MODE: "live", live, backtest: null };
}

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

function parseOrThrow<T extends z.ZodTypeAny>(
  section: string,
  schema: T,
  env: NodeJS.ProcessEnv,
): z.infer<T> {
  const parsed = schema.safeParse(env);
  if (parsed.success) {
    return parsed.data;
  }
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  throw new ConfigValidationError(
    `Config validation failed (${section}):\n${issues}`,
  );
}
