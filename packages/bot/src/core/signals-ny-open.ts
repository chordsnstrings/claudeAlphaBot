/**
 * Strategy B — NY Open Momentum per spec §3.
 *
 * Mirrors ARB structure but uses the pre-NY window (11:00–12:59 UTC) as
 * the range, the NY breakout window (13:00–14:59 UTC) for the entry, and
 * tighter parameters: range 0.3–2.0%, volume ≥ 1.4× avg, stop buffer 0.4·ATR,
 * TP1 1.5R, TP2 2.5R, time stop 20:00 UTC.
 */
import type { Candle, SignalIntent, Symbol as TradingSymbol } from "@hydra/shared";

import {
  NY_BREAKOUT_WINDOW,
  PRE_NY_WINDOW,
  candleInWindow,
  hasPriorBreakout,
  isUtcWeekend,
  preNyRange,
  utcDateKey,
  utcHourStart,
} from "./sessions.js";

export const DEFAULT_NY_MIN_RANGE_PCT = 0.3;
export const DEFAULT_NY_MAX_RANGE_PCT = 2.0;
export const DEFAULT_NY_VOLUME_MULTIPLIER = 1.4;
export const DEFAULT_NY_VOLUME_LOOKBACK = 20;
export const DEFAULT_NY_STOP_BUFFER_ATR = 0.4;
export const DEFAULT_NY_TP1_R = 1.5;
export const DEFAULT_NY_TP2_R = 2.5;
export const DEFAULT_NY_BREAKEVEN_R = 1.0;
export const DEFAULT_NY_TP1_ALLOC_PCT = 50;
export const DEFAULT_NY_TIME_STOP_HOUR_UTC = 20;

export interface NyOpenOptions {
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

export interface NyOpenInputs {
  readonly symbol: TradingSymbol;
  readonly candles: readonly Candle[];
  readonly atr: number;
  readonly hasExistingPosition: boolean;
  readonly opts?: NyOpenOptions;
}

export type NyOpenSkipReason =
  | "INSUFFICIENT_DATA"
  | "PRE_RANGE_MISSING"
  | "RANGE_TOO_TIGHT"
  | "RANGE_TOO_WIDE"
  | "OUTSIDE_WINDOW"
  | "NO_BREAKOUT"
  | "PRIOR_BREAKOUT"
  | "VOLUME_INSUFFICIENT"
  | "WEEKEND"
  | "EXISTING_POSITION";

export type NyOpenDecision =
  | { readonly type: "FIRE"; readonly signal: SignalIntent }
  | { readonly type: "SKIP"; readonly reason: NyOpenSkipReason; readonly detail?: string };

export function evaluateNyOpen(inputs: NyOpenInputs): NyOpenDecision {
  const opts = inputs.opts ?? {};
  const minRange = opts.minRangePct ?? DEFAULT_NY_MIN_RANGE_PCT;
  const maxRange = opts.maxRangePct ?? DEFAULT_NY_MAX_RANGE_PCT;
  const volMul = opts.volumeMultiplier ?? DEFAULT_NY_VOLUME_MULTIPLIER;
  const volLookback = opts.volumeLookback ?? DEFAULT_NY_VOLUME_LOOKBACK;
  const stopBuffer = opts.stopBufferAtr ?? DEFAULT_NY_STOP_BUFFER_ATR;
  const tp1R = opts.tp1Rmultiple ?? DEFAULT_NY_TP1_R;
  const tp2R = opts.tp2Rmultiple ?? DEFAULT_NY_TP2_R;
  const beR = opts.breakevenRmultiple ?? DEFAULT_NY_BREAKEVEN_R;
  const tp1Alloc = opts.tp1AllocationPct ?? DEFAULT_NY_TP1_ALLOC_PCT;
  const timeStopHour = opts.timeStopHourUtc ?? DEFAULT_NY_TIME_STOP_HOUR_UTC;
  const skipWeekends = opts.skipWeekends ?? true;

  const candles = inputs.candles;
  if (candles.length === 0) return { type: "SKIP", reason: "INSUFFICIENT_DATA" };
  const current = candles[candles.length - 1];
  if (!current) return { type: "SKIP", reason: "INSUFFICIENT_DATA" };
  if (!Number.isFinite(inputs.atr) || inputs.atr <= 0) {
    return { type: "SKIP", reason: "INSUFFICIENT_DATA" };
  }

  const dateKey = utcDateKey(current.openTime);

  if (skipWeekends && isUtcWeekend(current.openTime)) {
    return { type: "SKIP", reason: "WEEKEND" };
  }
  if (inputs.hasExistingPosition) {
    return { type: "SKIP", reason: "EXISTING_POSITION" };
  }
  if (!candleInWindow(current, dateKey, NY_BREAKOUT_WINDOW)) {
    return { type: "SKIP", reason: "OUTSIDE_WINDOW" };
  }

  const pre = preNyRange(candles, dateKey);
  if (!pre || pre.candleCount === 0 || pre.open <= 0) {
    return { type: "SKIP", reason: "PRE_RANGE_MISSING" };
  }

  const rangePct = ((pre.high - pre.low) / pre.open) * 100;
  if (rangePct < minRange) return { type: "SKIP", reason: "RANGE_TOO_TIGHT", detail: rangePct.toFixed(3) };
  if (rangePct > maxRange) return { type: "SKIP", reason: "RANGE_TOO_WIDE", detail: rangePct.toFixed(3) };

  let direction: "LONG" | "SHORT" | null = null;
  if (current.close > pre.high) direction = "LONG";
  else if (current.close < pre.low) direction = "SHORT";
  if (!direction) return { type: "SKIP", reason: "NO_BREAKOUT" };

  if (
    hasPriorBreakout(candles, current.openTime, NY_BREAKOUT_WINDOW, {
      high: pre.high,
      low: pre.low,
    })
  ) {
    return { type: "SKIP", reason: "PRIOR_BREAKOUT" };
  }

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

  const entry = current.close;
  const stop =
    direction === "LONG"
      ? pre.low - stopBuffer * inputs.atr
      : pre.high + stopBuffer * inputs.atr;
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
    strategy: "NY_OPEN",
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
      `NY_OPEN ${direction}: pre-range ${rangePct.toFixed(2)}% [${pre.low}-${pre.high}], ` +
      `breakout close ${entry} on ${(current.volume / volAvg).toFixed(2)}x volume`,
    meta: {
      preHigh: pre.high,
      preLow: pre.low,
      preOpen: pre.open,
      preRangePct: rangePct,
      atr: inputs.atr,
      volumeRatio: current.volume / volAvg,
      riskDistance,
      window: PRE_NY_WINDOW.startHour,
    },
  };
  return { type: "FIRE", signal };
}

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
