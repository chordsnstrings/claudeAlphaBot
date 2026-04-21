/**
 * Strategy A — Asian Range Breakout (ARB) per spec §2.
 *
 * Pure decision function: given the candle history through the candle
 * being evaluated, the precomputed ATR(14), and exogenous flags
 * (existing position), produce either FIRE with a fully-formed
 * SignalIntent or SKIP with a machine-readable reason code.
 *
 * Decision flow (spec §2.2):
 *   1. Compute Asian range (00:00-06:59 UTC of the current candle's day)
 *   2. Range filter: 0.4 ≤ range_pct ≤ 2.5
 *   3. Window check: current candle in 07:00-10:59 UTC
 *   4. Breakout direction: close above asian_high (LONG) or below asian_low (SHORT)
 *   5. First-breakout-only: no earlier candle in window already broke
 *   6. Volume confirmation: current vol ≥ 1.3 × avg(prev 20)
 *   7. Weekend filter (Sat/Sun UTC)
 *   8. Existing position check
 *
 * Exits (spec §2.3):
 *   stop      = asian_low − 0.5·ATR  (LONG) | asian_high + 0.5·ATR (SHORT)
 *   risk_dist = |entry − stop|
 *   tp1       = entry ± 1.5·risk (close 50%)
 *   tp2       = entry ± 3.0·risk (close 50%)
 *   breakeven = entry ± 1.0·risk
 *   time_stop = 20:00 UTC same day
 */
import type { Candle, SignalIntent, Symbol as TradingSymbol } from "@hydra/shared";

import {
  ARB_BREAKOUT_WINDOW,
  asianSessionRange,
  candleInWindow,
  hasPriorBreakout,
  isUtcWeekend,
  utcDateKey,
  utcHourStart,
} from "./sessions.js";

export const DEFAULT_MIN_RANGE_PCT = 0.4;
export const DEFAULT_MAX_RANGE_PCT = 2.5;
export const DEFAULT_VOLUME_MULTIPLIER = 1.3;
export const DEFAULT_VOLUME_LOOKBACK = 20;
export const DEFAULT_STOP_BUFFER_ATR = 0.5;
export const DEFAULT_TP1_R = 1.5;
export const DEFAULT_TP2_R = 3.0;
export const DEFAULT_BREAKEVEN_R = 1.0;
export const DEFAULT_TP1_ALLOC_PCT = 50;
export const DEFAULT_TIME_STOP_HOUR_UTC = 20;

export interface ArbOptions {
  readonly minRangePct?: number;
  readonly maxRangePct?: number;
  readonly volumeMultiplier?: number;
  readonly volumeLookback?: number;
  readonly stopBufferAtr?: number;
  readonly tp1Rmultiple?: number;
  readonly tp2Rmultiple?: number;
  readonly breakevenRmultiple?: number;
  readonly tp1AllocationPct?: number;
  readonly timeStopHourUtc?: number;
  readonly skipWeekends?: boolean;
}

export interface ArbInputs {
  readonly symbol: TradingSymbol;
  /** All available candles oldest → newest, including the candle under evaluation. */
  readonly candles: readonly Candle[];
  /** ATR(14) value at the candle under evaluation. Pass NaN to force INSUFFICIENT_DATA. */
  readonly atr: number;
  /** Whether the bot already has an open position on this symbol. */
  readonly hasExistingPosition: boolean;
  readonly opts?: ArbOptions;
}

export type ArbSkipReason =
  | "INSUFFICIENT_DATA"
  | "ASIAN_RANGE_MISSING"
  | "RANGE_TOO_TIGHT"
  | "RANGE_TOO_WIDE"
  | "OUTSIDE_WINDOW"
  | "NO_BREAKOUT"
  | "PRIOR_BREAKOUT"
  | "VOLUME_INSUFFICIENT"
  | "WEEKEND"
  | "EXISTING_POSITION";

export type ArbDecision =
  | { readonly type: "FIRE"; readonly signal: SignalIntent }
  | { readonly type: "SKIP"; readonly reason: ArbSkipReason; readonly detail?: string };

export function evaluateArb(inputs: ArbInputs): ArbDecision {
  const opts = inputs.opts ?? {};
  const minRange = opts.minRangePct ?? DEFAULT_MIN_RANGE_PCT;
  const maxRange = opts.maxRangePct ?? DEFAULT_MAX_RANGE_PCT;
  const volMul = opts.volumeMultiplier ?? DEFAULT_VOLUME_MULTIPLIER;
  const volLookback = opts.volumeLookback ?? DEFAULT_VOLUME_LOOKBACK;
  const stopBuffer = opts.stopBufferAtr ?? DEFAULT_STOP_BUFFER_ATR;
  const tp1R = opts.tp1Rmultiple ?? DEFAULT_TP1_R;
  const tp2R = opts.tp2Rmultiple ?? DEFAULT_TP2_R;
  const beR = opts.breakevenRmultiple ?? DEFAULT_BREAKEVEN_R;
  const tp1Alloc = opts.tp1AllocationPct ?? DEFAULT_TP1_ALLOC_PCT;
  const timeStopHour = opts.timeStopHourUtc ?? DEFAULT_TIME_STOP_HOUR_UTC;
  const skipWeekends = opts.skipWeekends ?? true;

  const candles = inputs.candles;
  if (candles.length === 0) return { type: "SKIP", reason: "INSUFFICIENT_DATA" };
  const current = candles[candles.length - 1];
  if (!current) return { type: "SKIP", reason: "INSUFFICIENT_DATA" };
  if (!Number.isFinite(inputs.atr) || inputs.atr <= 0) {
    return { type: "SKIP", reason: "INSUFFICIENT_DATA" };
  }

  const dateKey = utcDateKey(current.openTime);

  // 7. Weekend filter (cheap, do it first)
  if (skipWeekends && isUtcWeekend(current.openTime)) {
    return { type: "SKIP", reason: "WEEKEND" };
  }

  // 8. Existing position check
  if (inputs.hasExistingPosition) {
    return { type: "SKIP", reason: "EXISTING_POSITION" };
  }

  // 3. Window check
  if (!candleInWindow(current, dateKey, ARB_BREAKOUT_WINDOW)) {
    return { type: "SKIP", reason: "OUTSIDE_WINDOW" };
  }

  // 1. Asian range
  const asian = asianSessionRange(candles, dateKey);
  if (!asian || asian.candleCount === 0 || asian.open <= 0) {
    return { type: "SKIP", reason: "ASIAN_RANGE_MISSING" };
  }

  // 2. Range filter
  const rangePct = ((asian.high - asian.low) / asian.open) * 100;
  if (rangePct < minRange) return { type: "SKIP", reason: "RANGE_TOO_TIGHT", detail: rangePct.toFixed(3) };
  if (rangePct > maxRange) return { type: "SKIP", reason: "RANGE_TOO_WIDE", detail: rangePct.toFixed(3) };

  // 4. Breakout direction
  let direction: "LONG" | "SHORT" | null = null;
  if (current.close > asian.high) direction = "LONG";
  else if (current.close < asian.low) direction = "SHORT";
  if (!direction) return { type: "SKIP", reason: "NO_BREAKOUT" };

  // 5. First-breakout-only
  if (
    hasPriorBreakout(candles, current.openTime, ARB_BREAKOUT_WINDOW, {
      high: asian.high,
      low: asian.low,
    })
  ) {
    return { type: "SKIP", reason: "PRIOR_BREAKOUT" };
  }

  // 6. Volume confirmation
  const volAvg = trailingVolumeAverage(candles, candles.length - 1, volLookback);
  if (!Number.isFinite(volAvg) || volAvg <= 0) {
    return { type: "SKIP", reason: "INSUFFICIENT_DATA", detail: "volume_history" };
  }
  if (current.volume < volMul * volAvg) {
    return {
      type: "SKIP",
      reason: "VOLUME_INSUFFICIENT",
      detail: `${(current.volume / volAvg).toFixed(3)}x`,
    };
  }

  // ---- BUILD SIGNAL ----
  const entry = current.close;
  const stop =
    direction === "LONG"
      ? asian.low - stopBuffer * inputs.atr
      : asian.high + stopBuffer * inputs.atr;
  const riskDistance = Math.abs(entry - stop);
  if (riskDistance <= 0) {
    return { type: "SKIP", reason: "INSUFFICIENT_DATA", detail: "zero_risk_distance" };
  }
  const tp1 = direction === "LONG" ? entry + tp1R * riskDistance : entry - tp1R * riskDistance;
  const tp2 = direction === "LONG" ? entry + tp2R * riskDistance : entry - tp2R * riskDistance;
  const breakeven =
    direction === "LONG" ? entry + beR * riskDistance : entry - beR * riskDistance;
  const timeStopUtc = utcHourStart(dateKey, timeStopHour);

  const signal: SignalIntent = {
    strategy: "ARB",
    symbol: inputs.symbol,
    direction,
    generatedAt: current.closeTime,
    entryPrice: entry,
    stopPrice: stop,
    tp1Price: tp1,
    tp2Price: tp2,
    tp1AllocationPct: tp1Alloc,
    breakevenTriggerPrice: breakeven,
    timeStopUtc,
    reasoning:
      `ARB ${direction}: asian range ${rangePct.toFixed(2)}% [${asian.low}-${asian.high}], ` +
      `breakout close ${entry} on ${(current.volume / volAvg).toFixed(2)}x volume`,
    meta: {
      asianHigh: asian.high,
      asianLow: asian.low,
      asianOpen: asian.open,
      asianRangePct: rangePct,
      atr: inputs.atr,
      volumeRatio: current.volume / volAvg,
      riskDistance,
    },
  };
  return { type: "FIRE", signal };
}

/** Average of the previous `N` candles' volume, EXCLUDING the candle at `currentIdx`. */
function trailingVolumeAverage(
  candles: readonly Candle[],
  currentIdx: number,
  n: number,
): number {
  if (currentIdx < n) return Number.NaN;
  let sum = 0;
  for (let i = currentIdx - n; i < currentIdx; i++) {
    const c = candles[i];
    if (!c) return Number.NaN;
    sum += c.volume;
  }
  return sum / n;
}
