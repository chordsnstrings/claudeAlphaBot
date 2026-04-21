/**
 * Technical indicators for 1-hour OHLCV candles.
 *
 * All functions are pure (no I/O) and return NaN for insufficient
 * input — they never throw on short arrays. Algorithms match Binance
 * / TradingView conventions:
 *
 *   - EMA is seeded from the FIRST value (not an SMA warmup). This
 *     matches `pandas.ewm(adjust=False)` and TV's built-in EMA.
 *   - ATR uses Wilder's smoothing, not a rolling SMA. Many tutorials
 *     get this wrong.
 *   - Bollinger stddev uses POPULATION formula (divide by N), not
 *     sample (N-1). This is what TradingView uses.
 *   - RSI uses Wilder's smoothing of gains/losses (same decay as ATR).
 *   - ADX uses Wilder's smoothing for both +DI/-DI and then DX.
 *   - percentile is linear interpolation ("rank-match" style), the
 *     standard inclusive definition.
 *
 * Input convention:
 *   - Candle arrays are ordered oldest → newest.
 *   - Return arrays have the same length as input. Leading positions
 *     without enough warmup are filled with NaN.
 */
import type { Candle } from "@hydra/shared";

const NaN_ = Number.NaN;

/**
 * Exponential Moving Average, seeded from the first value.
 *   α = 2 / (N + 1)
 *   EMA[0] = values[0]
 *   EMA[t] = α·values[t] + (1−α)·EMA[t−1]
 */
export function ema(values: readonly number[], period: number): number[] {
  if (period <= 0) throw new Error("ema: period must be > 0");
  const out = new Array<number>(values.length).fill(NaN_);
  if (values.length === 0) return out;
  const alpha = 2 / (period + 1);
  const first = values[0];
  if (first === undefined) return out;
  out[0] = first;
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    const prev = out[i - 1];
    if (v === undefined || prev === undefined || !Number.isFinite(v) || !Number.isFinite(prev)) {
      continue;
    }
    out[i] = alpha * v + (1 - alpha) * prev;
  }
  return out;
}

/**
 * Simple Moving Average.
 *   SMA[t] = mean(values[t-N+1..t])
 * Leading N-1 positions are NaN.
 */
export function sma(values: readonly number[], period: number): number[] {
  if (period <= 0) throw new Error("sma: period must be > 0");
  const out = new Array<number>(values.length).fill(NaN_);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i] ?? 0;
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    sum += (values[i] ?? 0) - (values[i - period] ?? 0);
    out[i] = sum / period;
  }
  return out;
}

/**
 * True Range per Wilder.
 *   TR[t] = max( high[t]-low[t], |high[t]-close[t-1]|, |low[t]-close[t-1]| )
 *   TR[0] = high[0] - low[0]
 */
export function trueRange(candles: readonly Candle[]): number[] {
  const out = new Array<number>(candles.length).fill(NaN_);
  if (candles.length === 0) return out;
  const first = candles[0];
  if (first) out[0] = first.high - first.low;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    if (!c || !p) continue;
    const a = c.high - c.low;
    const b = Math.abs(c.high - p.close);
    const d = Math.abs(c.low - p.close);
    out[i] = Math.max(a, b, d);
  }
  return out;
}

/**
 * ATR with Wilder's smoothing.
 *   ATR[N-1] = mean(TR[0..N-1])
 *   ATR[t]   = (ATR[t-1]·(N-1) + TR[t]) / N     for t ≥ N
 * Positions 0..N-2 are NaN.
 */
export function atr(candles: readonly Candle[], period = 14): number[] {
  if (period <= 0) throw new Error("atr: period must be > 0");
  const tr = trueRange(candles);
  const out = new Array<number>(candles.length).fill(NaN_);
  if (candles.length < period) return out;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i] ?? 0;
  out[period - 1] = sum / period;
  for (let i = period; i < candles.length; i++) {
    const prev = out[i - 1];
    const t = tr[i];
    if (prev === undefined || t === undefined) continue;
    out[i] = (prev * (period - 1) + t) / period;
  }
  return out;
}

/**
 * RSI with Wilder's smoothing on gains/losses.
 *   For each step: gain = max(0, close[t] − close[t-1])
 *                  loss = max(0, close[t-1] − close[t])
 *   avg_gain[N] = mean(gains[1..N]);  avg_loss similarly
 *   avg_gain[t] = (avg_gain[t-1]·(N-1) + gain[t]) / N
 *   RS = avg_gain / avg_loss;  RSI = 100 − 100/(1+RS)
 * Leading N positions are NaN (we need N deltas, which need N+1 closes).
 */
export function rsi(closes: readonly number[], period = 14): number[] {
  if (period <= 0) throw new Error("rsi: period must be > 0");
  const out = new Array<number>(closes.length).fill(NaN_);
  if (closes.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const c = closes[i];
    const p = closes[i - 1];
    if (c === undefined || p === undefined) return out;
    const diff = c - p;
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff; // diff is negative, loss = -diff
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsFromAvgs(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const c = closes[i];
    const p = closes[i - 1];
    if (c === undefined || p === undefined) continue;
    const diff = c - p;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsFromAvgs(avgGain, avgLoss);
  }
  return out;
}

function rsFromAvgs(gain: number, loss: number): number {
  if (loss === 0) return gain === 0 ? 50 : 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

/**
 * Bollinger Bands (period, stddev multiplier). Population stddev.
 * Returns arrays for upper, middle, lower, and bandwidth (= (U-L)/M).
 */
export interface BollingerResult {
  readonly middle: number[];
  readonly upper: number[];
  readonly lower: number[];
  readonly bandwidth: number[];
}

export function bollinger(
  values: readonly number[],
  period = 14,
  k = 2,
): BollingerResult {
  if (period <= 0) throw new Error("bollinger: period must be > 0");
  const n = values.length;
  const middle = new Array<number>(n).fill(NaN_);
  const upper = new Array<number>(n).fill(NaN_);
  const lower = new Array<number>(n).fill(NaN_);
  const bandwidth = new Array<number>(n).fill(NaN_);
  if (n < period) return { middle, upper, lower, bandwidth };

  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j] ?? 0;
    const mean = sum / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j] ?? 0;
      sq += (v - mean) * (v - mean);
    }
    const std = Math.sqrt(sq / period); // POPULATION stddev
    middle[i] = mean;
    upper[i] = mean + k * std;
    lower[i] = mean - k * std;
    bandwidth[i] = mean === 0 ? NaN_ : (2 * k * std) / mean;
  }
  return { middle, upper, lower, bandwidth };
}

/**
 * ADX (14) — Wilder's Average Directional Index with +DI/-DI.
 * Returns { plusDI, minusDI, adx } with leading positions NaN.
 *
 * Process:
 *   1. Compute +DM, -DM, TR per candle.
 *   2. Wilder-smooth each over `period` periods.
 *   3. +DI = 100 · smoothed_+DM / smoothed_TR; similarly -DI.
 *   4. DX = 100 · |+DI − -DI| / (+DI + -DI).
 *   5. ADX = Wilder-smoothed DX over `period`.
 *
 * The first ADX value appears at index 2·period − 1 (warmup + DX smoothing).
 */
export interface AdxResult {
  readonly plusDI: number[];
  readonly minusDI: number[];
  readonly adx: number[];
}

export function adx(candles: readonly Candle[], period = 14): AdxResult {
  if (period <= 0) throw new Error("adx: period must be > 0");
  const n = candles.length;
  const plusDI = new Array<number>(n).fill(NaN_);
  const minusDI = new Array<number>(n).fill(NaN_);
  const adxOut = new Array<number>(n).fill(NaN_);

  if (n < period + 1) return { plusDI, minusDI, adx: adxOut };

  // Step 1: +DM, -DM, TR arrays (both empty at index 0).
  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  const tr = new Array<number>(n).fill(0);

  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    if (!c || !p) continue;
    const upMove = c.high - p.high;
    const downMove = p.low - c.low;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    const a = c.high - c.low;
    const b = Math.abs(c.high - p.close);
    const d = Math.abs(c.low - p.close);
    tr[i] = Math.max(a, b, d);
  }

  // Step 2: seed Wilder-smoothed sums at index `period` using the sum
  // of the first `period` values (indices 1..period inclusive).
  let smPlus = 0;
  let smMinus = 0;
  let smTr = 0;
  for (let i = 1; i <= period; i++) {
    smPlus += plusDM[i] ?? 0;
    smMinus += minusDM[i] ?? 0;
    smTr += tr[i] ?? 0;
  }

  const dx = new Array<number>(n).fill(NaN_);

  // Initial DI at index `period`
  plusDI[period] = smTr === 0 ? 0 : (100 * smPlus) / smTr;
  minusDI[period] = smTr === 0 ? 0 : (100 * smMinus) / smTr;
  dx[period] = diToDx(plusDI[period]!, minusDI[period]!);

  // Step 3: walk forward with Wilder smoothing
  for (let i = period + 1; i < n; i++) {
    smPlus = smPlus - smPlus / period + (plusDM[i] ?? 0);
    smMinus = smMinus - smMinus / period + (minusDM[i] ?? 0);
    smTr = smTr - smTr / period + (tr[i] ?? 0);
    plusDI[i] = smTr === 0 ? 0 : (100 * smPlus) / smTr;
    minusDI[i] = smTr === 0 ? 0 : (100 * smMinus) / smTr;
    dx[i] = diToDx(plusDI[i]!, minusDI[i]!);
  }

  // Step 4: ADX = Wilder-smoothed DX over `period`. First ADX appears
  // at index 2·period − 1 using mean of DX[period..2·period−1].
  const firstAdxIdx = 2 * period - 1;
  if (n <= firstAdxIdx) return { plusDI, minusDI, adx: adxOut };

  let dxSum = 0;
  for (let i = period; i < firstAdxIdx + 1; i++) dxSum += dx[i] ?? 0;
  adxOut[firstAdxIdx] = dxSum / period;
  for (let i = firstAdxIdx + 1; i < n; i++) {
    const prev = adxOut[i - 1];
    const cur = dx[i];
    if (prev === undefined || cur === undefined) continue;
    adxOut[i] = (prev * (period - 1) + cur) / period;
  }

  return { plusDI, minusDI, adx: adxOut };
}

function diToDx(plus: number, minus: number): number {
  const sum = plus + minus;
  if (sum === 0) return 0;
  return (100 * Math.abs(plus - minus)) / sum;
}

/**
 * Percentile rank (inclusive, linear interpolation) of `value` among
 * `sample`, returned in [0, 100]. Uses the "fraction ≤" definition
 * that TradingView calls `percentile_nearest_rank` — simple and
 * deterministic for BB-width history.
 *
 * - empty sample or NaN value → NaN
 * - value below all → 0
 * - value at or above all → 100
 */
export function percentileRank(sample: readonly number[], value: number): number {
  if (!Number.isFinite(value) || sample.length === 0) return NaN_;
  const sorted = [...sample].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return NaN_;
  let below = 0;
  let equal = 0;
  for (const v of sorted) {
    if (v < value) below += 1;
    else if (v === value) equal += 1;
    else break;
  }
  // Midrank: counts half of ties
  const rank = below + equal / 2;
  return (rank / sorted.length) * 100;
}

/**
 * p-th percentile (0..100) of a sample with linear interpolation
 * between closest ranks — matches numpy's default "linear" method.
 * Returns NaN on empty input.
 */
export function percentile(sample: readonly number[], p: number): number {
  if (sample.length === 0) return NaN_;
  if (p < 0 || p > 100) throw new Error("percentile: p must be in [0, 100]");
  const sorted = [...sample].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return NaN_;
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

/**
 * Slope (first-difference-over-period) of an indicator — used by
 * §8.12 to classify trend direction of EMA(99). Returns (y[t] − y[t−k]) / k.
 * NaN if insufficient data.
 */
export function slope(values: readonly number[], period: number): number {
  if (values.length <= period) return NaN_;
  const last = values[values.length - 1];
  const prev = values[values.length - 1 - period];
  if (last === undefined || prev === undefined || !Number.isFinite(last) || !Number.isFinite(prev)) {
    return NaN_;
  }
  return (last - prev) / period;
}
