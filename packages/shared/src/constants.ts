/**
 * Shared enums and literal-union constants.
 *
 * Every value here must be an `as const` literal so both bot and UI
 * can narrow on exact string comparisons without importing a runtime enum.
 */

export const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;
export type Symbol = (typeof SYMBOLS)[number];

export const STRATEGIES = [
  "ARB",
  "NY_OPEN",
  "WEEKEND_MR",
  "FUNDING_FADE",
  "BB_MR",
] as const;
export type StrategyName = (typeof STRATEGIES)[number];

export const DIRECTIONS = ["LONG", "SHORT"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const MODES = ["backtest", "paper", "live"] as const;
export type BotMode = (typeof MODES)[number];

export const REGIMES = [
  "RANGING",
  "TRENDING_UP",
  "TRENDING_DOWN",
  "SQUEEZE",
  "TRANSITION",
] as const;
export type Regime = (typeof REGIMES)[number];

export const EXIT_REASONS = [
  "STOP",
  "TP1",
  "TP2",
  "TIME_STOP",
  "BREAKEVEN",
  "CIRCUIT_BREAKER",
  "MANUAL",
] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];

export const DRIFT_OUTCOMES = ["UNCHANGED", "DRIFTED", "FLIPPED"] as const;
export type DriftOutcome = (typeof DRIFT_OUTCOMES)[number];

export const PORTFOLIO_OUTCOMES = [
  "PORTFOLIO_UNCHANGED",
  "PORTFOLIO_DRIFTED",
  "PORTFOLIO_FLIPPED",
] as const;
export type PortfolioOutcome = (typeof PORTFOLIO_OUTCOMES)[number];

export const REVAL_TRIGGERS = [
  "FLIPPED",
  "PERFORMANCE_DECAY",
  "VOL_SHIFT",
  "CODE_CHANGE",
  "MANUAL",
  "FORTNIGHTLY",
] as const;
export type RevalTrigger = (typeof REVAL_TRIGGERS)[number];

export const CIRCUIT_BREAKER_KINDS = [
  "DAILY_LOSS_CAP",
  "WEEKLY_LOSS_CAP",
  "SYMBOL_COOLDOWN",
  "MANUAL_HALT",
] as const;
export type CircuitBreakerKind = (typeof CIRCUIT_BREAKER_KINDS)[number];
