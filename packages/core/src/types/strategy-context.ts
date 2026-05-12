/**
 * Per-strategy bootstrap context. The engine calls `strategy.initialize(ctx)`
 * once at session start; the strategy stores anything it needs and never
 * touches the live DB or wall clock directly afterwards.
 *
 * Spec §5.1 — StrategyContext.
 */

import type { Timeframe } from "./bar.js";

export interface StrategyConfig {
  /** Stable strategy identifier (kebab-case, e.g. 'asian-range-sweep'). */
  name: string;
  /** Free-form per-strategy parameters. */
  parameters: Record<string, unknown>;
  /** Instruments this strategy is enabled for. */
  instruments: string[];
  /** Timeframes the strategy operates on; usually a single value. */
  timeframes: Timeframe[];
  /** Fraction of account equity allocated to this strategy, 0..1. */
  allocationFraction: number;
  enabled: boolean;
}

export interface StrategyContext {
  /** UUID of the current session. */
  sessionId: string;
  config: StrategyConfig;
  /** Mode is exposed for telemetry, not branching: strategies must behave the same. */
  mode: "backtest" | "live";
  /** Account equity at session start; for normalising position sizes. */
  initialEquityUsd: number;
}
