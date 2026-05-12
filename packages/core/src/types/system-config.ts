/**
 * The richer engine-facing SystemConfig per spec §1.4 / §4.4.
 *
 * `EnvConfig` (loaded from env vars) is the foundation; SystemConfig adds
 * runtime extras — the strategies list, RiskConfig, OrchestratorMode —
 * that don't fit in env vars.
 *
 * `resolveSystemConfig(envConfig, runtimeExtras)` produces a SystemConfig.
 */

import type { EnvConfig } from "../config.js";
import type { Timeframe } from "./bar.js";
import { DEFAULT_RISK_CONFIG, type RiskConfig } from "./risk-config.js";
import type { StrategyConfig } from "./strategy-context.js";

export type OrchestratorMode = "equal_weight" | "risk_parity" | "regime_switched";

export type FrictionProfile =
  | "pepperstone_razor"
  | "zero_friction"
  | "pessimistic";

export interface BacktestSettings {
  startDate: Date;
  endDate: Date;
  instruments: string[];
  timeframes: Timeframe[];
  initialEquityUsd: number;
  frictionProfile: FrictionProfile;
  /** Deterministic randomness for the friction model and shuffles. */
  randomSeed: bigint;
}

export interface LiveSettings {
  accountType: "demo" | "live";
  ctraderClientId: string;
  ctraderClientSecret: string;
  ctraderAccessToken: string;
  ctraderRefreshToken: string;
  ctraderAccountId: string;
  instrumentsTraded: string[];
}

export type SystemConfig =
  | {
      sessionId: string;
      mode: "backtest";
      database: { connectionString: string; poolSize: number };
      backtest: BacktestSettings;
      live: null;
      strategies: StrategyConfig[];
      orchestratorMode: OrchestratorMode;
      riskConfig: RiskConfig;
      logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
      /** Git SHA at session start; recorded in the session row. */
      codeVersion: string;
    }
  | {
      sessionId: string;
      mode: "live";
      database: { connectionString: string; poolSize: number };
      backtest: null;
      live: LiveSettings;
      strategies: StrategyConfig[];
      orchestratorMode: OrchestratorMode;
      riskConfig: RiskConfig;
      logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
      codeVersion: string;
    };

/** Inputs that don't come from env vars; supplied by the caller. */
export interface RuntimeExtras {
  sessionId: string;
  strategies: StrategyConfig[];
  orchestratorMode: OrchestratorMode;
  riskConfig?: RiskConfig;
  codeVersion: string;
  /** Override instruments/timeframes from env defaults if needed. */
  instruments?: string[];
  timeframes?: Timeframe[];
}

/**
 * Compose an env-loaded {@link EnvConfig} with caller-supplied runtime
 * extras into a fully-resolved {@link SystemConfig}.
 */
export function resolveSystemConfig(
  env: EnvConfig,
  extras: RuntimeExtras,
): SystemConfig {
  const riskConfig = extras.riskConfig ?? DEFAULT_RISK_CONFIG;
  const database = {
    connectionString: env.DATABASE_URL,
    poolSize: env.DATABASE_POOL_SIZE,
  };
  if (env.MODE === "backtest") {
    const bt = env.backtest;
    const backtest: BacktestSettings = {
      startDate: new Date(`${bt.BACKTEST_START_DATE}T00:00:00Z`),
      endDate: new Date(`${bt.BACKTEST_END_DATE}T00:00:00Z`),
      instruments: extras.instruments ?? [],
      timeframes: extras.timeframes ?? ["d1"],
      initialEquityUsd: bt.BACKTEST_INITIAL_EQUITY_USD,
      frictionProfile: bt.BACKTEST_FRICTION_PROFILE,
      randomSeed: bt.BACKTEST_RANDOM_SEED,
    };
    return {
      sessionId: extras.sessionId,
      mode: "backtest",
      database,
      backtest,
      live: null,
      strategies: extras.strategies,
      orchestratorMode: extras.orchestratorMode,
      riskConfig,
      logLevel: env.LOG_LEVEL,
      codeVersion: extras.codeVersion,
    };
  }
  const lv = env.live;
  const live: LiveSettings = {
    accountType: lv.CTRADER_ACCOUNT_TYPE,
    ctraderClientId: lv.CTRADER_CLIENT_ID,
    ctraderClientSecret: lv.CTRADER_CLIENT_SECRET,
    ctraderAccessToken: lv.CTRADER_ACCESS_TOKEN,
    ctraderRefreshToken: lv.CTRADER_REFRESH_TOKEN,
    ctraderAccountId: lv.CTRADER_ACCOUNT_ID,
    instrumentsTraded: extras.instruments ?? [],
  };
  return {
    sessionId: extras.sessionId,
    mode: "live",
    database,
    backtest: null,
    live,
    strategies: extras.strategies,
    orchestratorMode: extras.orchestratorMode,
    riskConfig,
    logLevel: env.LOG_LEVEL,
    codeVersion: extras.codeVersion,
  };
}
