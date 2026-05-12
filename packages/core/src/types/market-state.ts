/** Spec §5.1 — MarketState passed to strategies on each bar. */

import type { AdxPoint, BollingerPoint } from "../indicators/index.js";
import type { Bar } from "./bar.js";
import type { Position } from "./position.js";

/**
 * Full indicator snapshot computed from the trailing window of bars for
 * the current instrument/timeframe. Every entry is the value AT the
 * current bar; null means insufficient history.
 */
export interface IndicatorSnapshot {
  atr14: number | null;
  atr20: number | null;
  adx14: AdxPoint | null;
  sma20: number | null;
  sma50: number | null;
  sma100: number | null;
  sma200: number | null;
  ema20: number | null;
  ema50: number | null;
  rsi14: number | null;
  bb20: BollingerPoint | null;
  /** ATR(14) percentile rank within the trailing 60 ATR values, 0..1. */
  atrPercentile60: number | null;
  /** Past return over the last 252 bars (one trading year for daily). */
  pastReturn252: number | null;
  /** Rolling high/low EXCLUDING the current bar. */
  rollingHigh20: number | null;
  rollingHigh55: number | null;
  rollingLow20: number | null;
  rollingLow55: number | null;
}

export type SessionWindow = "asia" | "london" | "ny" | "overlap" | "closed";

export interface SessionContext {
  /** High of the Asian session in this bar's instrument; null pre-Asia. */
  asianHigh: number | null;
  asianLow: number | null;
  currentSession: SessionWindow;
  /** Seconds until the current session window closes. */
  secondsToSessionClose: number;
  /** True if a high-impact news release is within +/- the configured window. */
  isInNewsWindow: boolean;
}

export interface MarketState {
  currentBar: Bar;
  instrument: string;
  /** Trailing window of bars; default 500. Always includes currentBar as last. */
  recentBars: Bar[];
  indicators: IndicatorSnapshot;
  sessionContext: SessionContext;
  /** Positions owned by the strategy reading this state, not all open positions. */
  currentPositions: Position[];
  /** Account equity in USD at the moment this state was built. */
  accountEquity: number;
  /** Per Clock; in backtest this is the bar's timestamp. */
  now: Date;
}
