/**
 * Regime classifier (spec §8.12.1).
 *
 * For each symbol, returns one of:
 *   RANGING, TRENDING_UP, TRENDING_DOWN, SQUEEZE, TRANSITION
 *
 * Signal features (matching §8.12.6 validation_snapshot fields):
 *   - bb_width_pct      : percentile of current BB bandwidth vs
 *                         trailing N-candle distribution (default 100)
 *   - ema99_slope_pct   : (ema99[t] − ema99[t−SLOPE_LOOKBACK]) / close[t]
 *                         expressed as % per candle
 *   - atr_pct           : ATR(14) / close × 100
 *
 * Classification rules (tunable via options; defaults below):
 *   - SQUEEZE        : bb_width_pct <= SQUEEZE_PCTILE (default 20)
 *   - TRENDING_UP    : ema99_slope_pct >= TREND_SLOPE_PCT_PER_CANDLE
 *   - TRENDING_DOWN  : ema99_slope_pct <= −TREND_SLOPE_PCT_PER_CANDLE
 *   - RANGING        : otherwise
 *   - TRANSITION     : classification just flipped within the last
 *                      TRANSITION_WINDOW candles (overrides the base
 *                      classification until stabilization)
 *
 * Confidence [0, 1]: how deep into the current regime we are.
 *   - SQUEEZE   : 1 − (bb_width_pct / SQUEEZE_PCTILE), clamped [0, 1]
 *   - TRENDING  : clamp(|slope| / (2 × TREND_SLOPE_PCT_PER_CANDLE))
 *   - RANGING   : 1 − clamp(|slope| / TREND_SLOPE_PCT_PER_CANDLE)
 *   - TRANSITION: 0.5 (by definition, uncertain)
 */
import type { Candle } from "@hydra/shared";
import type { Regime } from "@hydra/shared";

import { atr, bollinger, ema, percentileRank, slope } from "./indicators.js";

export const DEFAULT_BB_PERIOD = 14;
export const DEFAULT_BB_K = 2;
export const DEFAULT_BB_LOOKBACK = 100;
export const DEFAULT_ATR_PERIOD = 14;
export const DEFAULT_EMA_PERIOD = 99;
export const DEFAULT_SLOPE_LOOKBACK = 20;
export const DEFAULT_SQUEEZE_PCTILE = 20; // bottom 20% of BB widths
export const DEFAULT_TREND_SLOPE_PCT = 0.05; // % of price per candle
export const DEFAULT_TRANSITION_WINDOW = 3; // candles

export interface RegimeClassifierOptions {
  readonly bbPeriod?: number;
  readonly bbK?: number;
  readonly bbLookback?: number;
  readonly atrPeriod?: number;
  readonly emaPeriod?: number;
  readonly slopeLookback?: number;
  readonly squeezePctile?: number;
  readonly trendSlopePct?: number;
  readonly transitionWindow?: number;
}

export interface RegimeResult {
  readonly regime: Regime;
  readonly confidence: number;
  readonly bbWidthPctile: number;
  readonly ema99Slope: number;        // raw slope (value per candle in price units)
  readonly ema99SlopePct: number;     // slope as % of current close per candle
  readonly atrPct: number;            // ATR / close × 100
  /** Base classification ignoring TRANSITION override. For tests + drift logic. */
  readonly baseRegime: Regime;
}

/**
 * Classify the CURRENT regime (last candle) based on the input series.
 *
 * Input must be ordered oldest → newest. Returns a result with NaN
 * metrics and `regime="RANGING"` when there's insufficient data
 * (can't throw because classifier is hot-path in scheduler).
 */
export function classifyRegime(
  candles: readonly Candle[],
  opts: RegimeClassifierOptions = {},
): RegimeResult {
  const bbPeriod = opts.bbPeriod ?? DEFAULT_BB_PERIOD;
  const bbK = opts.bbK ?? DEFAULT_BB_K;
  const bbLookback = opts.bbLookback ?? DEFAULT_BB_LOOKBACK;
  const atrPeriod = opts.atrPeriod ?? DEFAULT_ATR_PERIOD;
  const emaPeriod = opts.emaPeriod ?? DEFAULT_EMA_PERIOD;
  const slopeLookback = opts.slopeLookback ?? DEFAULT_SLOPE_LOOKBACK;
  const squeezePctile = opts.squeezePctile ?? DEFAULT_SQUEEZE_PCTILE;
  const trendSlopePct = opts.trendSlopePct ?? DEFAULT_TREND_SLOPE_PCT;
  const transitionWindow = opts.transitionWindow ?? DEFAULT_TRANSITION_WINDOW;

  const empty: RegimeResult = {
    regime: "RANGING",
    baseRegime: "RANGING",
    confidence: 0,
    bbWidthPctile: Number.NaN,
    ema99Slope: Number.NaN,
    ema99SlopePct: Number.NaN,
    atrPct: Number.NaN,
  };

  if (candles.length < Math.max(emaPeriod + slopeLookback, bbLookback + bbPeriod, atrPeriod)) {
    return empty;
  }

  const last = candles.length - 1;
  const lastCandle = candles[last];
  if (!lastCandle) return empty;
  const close = lastCandle.close;

  const closes = candles.map((c) => c.close);
  const bb = bollinger(closes, bbPeriod, bbK);
  const atrArr = atr(candles, atrPeriod);
  const emaArr = ema(closes, emaPeriod);

  const bwLast = bb.bandwidth[last];
  const atrLast = atrArr[last];

  // Trailing distribution of BB widths over the last `bbLookback` values
  const bwHistory: number[] = [];
  for (let i = last - bbLookback + 1; i <= last; i++) {
    const v = bb.bandwidth[i];
    if (v !== undefined && Number.isFinite(v)) bwHistory.push(v);
  }
  const bbWidthPctile =
    bwLast !== undefined && Number.isFinite(bwLast) && bwHistory.length > 0
      ? percentileRank(bwHistory, bwLast)
      : Number.NaN;

  const emaSlopeRaw = slope(emaArr, slopeLookback);
  const emaSlopePct = close > 0 && Number.isFinite(emaSlopeRaw) ? (emaSlopeRaw / close) * 100 : Number.NaN;

  const atrPct = close > 0 && atrLast !== undefined && Number.isFinite(atrLast)
    ? (atrLast / close) * 100
    : Number.NaN;

  // Current classification
  const base = classifyOne({
    bbWidthPctile,
    emaSlopePct,
    squeezePctile,
    trendSlopePct,
  });
  const confidence = confidenceFor(base, {
    bbWidthPctile,
    emaSlopePct,
    squeezePctile,
    trendSlopePct,
  });

  // TRANSITION detection: compare to classification at last − transitionWindow
  let regime: Regime = base;
  if (transitionWindow > 0 && candles.length > transitionWindow + 1) {
    const prior = classifyAt(candles, last - transitionWindow, {
      bbPeriod,
      bbK,
      bbLookback,
      atrPeriod,
      emaPeriod,
      slopeLookback,
      squeezePctile,
      trendSlopePct,
    });
    if (prior !== null && prior !== base) regime = "TRANSITION";
  }

  return {
    regime,
    baseRegime: base,
    confidence: regime === "TRANSITION" ? 0.5 : confidence,
    bbWidthPctile,
    ema99Slope: emaSlopeRaw,
    ema99SlopePct: emaSlopePct,
    atrPct,
  };
}

/**
 * Classify the regime at an historical index — used for TRANSITION
 * detection. Reuses the same rules but computes metrics at that
 * specific cutoff. Returns null on insufficient data.
 */
function classifyAt(
  candles: readonly Candle[],
  idx: number,
  opts: Required<Pick<RegimeClassifierOptions,
    "bbPeriod" | "bbK" | "bbLookback" | "atrPeriod" | "emaPeriod" | "slopeLookback" | "squeezePctile" | "trendSlopePct">>,
): Regime | null {
  if (idx < 0) return null;
  const windowRequired = Math.max(opts.emaPeriod + opts.slopeLookback, opts.bbLookback + opts.bbPeriod, opts.atrPeriod);
  if (idx < windowRequired - 1) return null;
  const sliced = candles.slice(0, idx + 1);
  const c = sliced[sliced.length - 1];
  if (!c) return null;
  const closes = sliced.map((x) => x.close);
  const bb = bollinger(closes, opts.bbPeriod, opts.bbK);
  const emaArr = ema(closes, opts.emaPeriod);
  const i = sliced.length - 1;
  const bwLast = bb.bandwidth[i];
  const bwHistory: number[] = [];
  for (let j = i - opts.bbLookback + 1; j <= i; j++) {
    const v = bb.bandwidth[j];
    if (v !== undefined && Number.isFinite(v)) bwHistory.push(v);
  }
  const pctile =
    bwLast !== undefined && Number.isFinite(bwLast) && bwHistory.length > 0
      ? percentileRank(bwHistory, bwLast)
      : Number.NaN;
  const emaSlopeRaw = slope(emaArr, opts.slopeLookback);
  const slopePct = c.close > 0 && Number.isFinite(emaSlopeRaw) ? (emaSlopeRaw / c.close) * 100 : Number.NaN;
  return classifyOne({
    bbWidthPctile: pctile,
    emaSlopePct: slopePct,
    squeezePctile: opts.squeezePctile,
    trendSlopePct: opts.trendSlopePct,
  });
}

function classifyOne(args: {
  bbWidthPctile: number;
  emaSlopePct: number;
  squeezePctile: number;
  trendSlopePct: number;
}): Regime {
  const { bbWidthPctile, emaSlopePct, squeezePctile, trendSlopePct } = args;
  if (Number.isFinite(bbWidthPctile) && bbWidthPctile <= squeezePctile) return "SQUEEZE";
  if (Number.isFinite(emaSlopePct)) {
    if (emaSlopePct >= trendSlopePct) return "TRENDING_UP";
    if (emaSlopePct <= -trendSlopePct) return "TRENDING_DOWN";
  }
  return "RANGING";
}

function confidenceFor(
  r: Regime,
  args: { bbWidthPctile: number; emaSlopePct: number; squeezePctile: number; trendSlopePct: number },
): number {
  const { bbWidthPctile, emaSlopePct, squeezePctile, trendSlopePct } = args;
  const mag = Math.abs(emaSlopePct);
  const clamp = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
  if (r === "SQUEEZE") {
    if (!Number.isFinite(bbWidthPctile)) return 0.5;
    return clamp(1 - bbWidthPctile / squeezePctile);
  }
  if (r === "TRENDING_UP" || r === "TRENDING_DOWN") {
    if (!Number.isFinite(mag)) return 0.5;
    return clamp(mag / (2 * trendSlopePct));
  }
  if (r === "RANGING") {
    if (!Number.isFinite(mag)) return 0.5;
    return clamp(1 - mag / trendSlopePct);
  }
  return 0.5;
}
