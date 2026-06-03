// indicators.ts — pure functions over Bar arrays. All return arrays aligned to input.

import { Bar } from "./types";

export const closes = (bars: Bar[]) => bars.map((b) => b.close);
export const highs = (bars: Bar[]) => bars.map((b) => b.high);
export const lows = (bars: Bar[]) => bars.map((b) => b.low);

/** Simple moving average; returns NaN until enough bars. */
export function sma(values: number[], n: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** Exponential moving average. */
export function ema(values: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = new Array(values.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    if (i === 0) prev = values[i];
    else prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder-smoothed moving average (alpha = 1/n). */
export function wilder(values: number[], n: number): number[] {
  const alpha = 1 / n;
  const out: number[] = new Array(values.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    if (isNaN(prev)) prev = values[i];
    else prev = values[i] * alpha + prev * (1 - alpha);
    out[i] = prev;
  }
  return out;
}

/** True Range. */
export function trueRange(bars: Bar[]): number[] {
  const out: number[] = new Array(bars.length).fill(NaN);
  for (let i = 0; i < bars.length; i++) {
    const h = bars[i].high;
    const l = bars[i].low;
    if (i === 0) {
      out[i] = h - l;
    } else {
      const pc = bars[i - 1].close;
      out[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
  }
  return out;
}

/** ATR (Wilder-smoothed true range). */
export function atr(bars: Bar[], n: number = 14): number[] {
  return wilder(trueRange(bars), n);
}

/** ATR as fraction of price. */
export function atrFrac(bars: Bar[], n: number = 14): number[] {
  const a = atr(bars, n);
  return a.map((v, i) => (bars[i].close > 0 ? v / bars[i].close : NaN));
}

/** ADX (Wilder). Standard 14-period. */
export function adx(bars: Bar[], n: number = 14): number[] {
  const len = bars.length;
  const out: number[] = new Array(len).fill(NaN);
  if (len < n + 1) return out;
  const tr = trueRange(bars);
  const plusDM: number[] = new Array(len).fill(0);
  const minusDM: number[] = new Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    const upMove = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    if (upMove > downMove && upMove > 0) plusDM[i] = upMove;
    if (downMove > upMove && downMove > 0) minusDM[i] = downMove;
  }
  const tr14 = wilder(tr, n);
  const pdm14 = wilder(plusDM, n);
  const mdm14 = wilder(minusDM, n);
  const dx: number[] = new Array(len).fill(NaN);
  for (let i = 0; i < len; i++) {
    if (tr14[i] > 0) {
      const pdi = (100 * pdm14[i]) / tr14[i];
      const mdi = (100 * mdm14[i]) / tr14[i];
      const sum = pdi + mdi;
      dx[i] = sum > 0 ? (100 * Math.abs(pdi - mdi)) / sum : 0;
    }
  }
  return wilder(dx, n);
}

/** Donchian channel: returns [low_N, high_N] for each bar (causal, shifted). */
export function donchian(bars: Bar[], n: number): { low: number[]; high: number[] } {
  const low: number[] = new Array(bars.length).fill(NaN);
  const high: number[] = new Array(bars.length).fill(NaN);
  for (let i = 1; i < bars.length; i++) {
    const start = Math.max(0, i - n);
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = start; j < i; j++) {
      if (bars[j].low < lo) lo = bars[j].low;
      if (bars[j].high > hi) hi = bars[j].high;
    }
    if (i >= n) {
      low[i] = lo;
      high[i] = hi;
    }
  }
  return { low, high };
}

/** Percentage change over n bars (close to close). */
export function pctChange(values: number[], n: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  for (let i = n; i < values.length; i++) {
    if (values[i - n] > 0) out[i] = values[i] / values[i - n] - 1;
  }
  return out;
}

/** Standard deviation of last n values. */
export function stdDev(values: number[], n: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  for (let i = n - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += values[j];
    const mean = sum / n;
    let varSum = 0;
    for (let j = i - n + 1; j <= i; j++) varSum += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(varSum / n);
  }
  return out;
}
