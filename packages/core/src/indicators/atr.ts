/**
 * Average True Range (Wilder, 1978).
 *
 *   TR_t = max(High_t - Low_t, |High_t - Close_{t-1}|, |Low_t - Close_{t-1}|)
 *
 *   ATR seed (period N) = (1/N) * sum of TR for bars 1..N
 *   ATR_t (t > N)       = ((N-1) * ATR_{t-1} + TR_t) / N      (Wilder smoothing)
 *
 * Note: index 0 has no previous close, so TR_0 = High_0 - Low_0.
 */

import type { OhlcvBar, StreamingIndicator } from "./types.js";

export function trueRange(
  bar: OhlcvBar,
  prevClose: number | null,
): number {
  const range = bar.high - bar.low;
  if (prevClose === null) {
    return range;
  }
  const a = Math.abs(bar.high - prevClose);
  const b = Math.abs(bar.low - prevClose);
  return Math.max(range, a, b);
}

export function atr(bars: readonly OhlcvBar[], period: number): Array<number | null> {
  if (period < 1) {
    throw new Error("atr: period must be >= 1");
  }
  const n = bars.length;
  const out: Array<number | null> = new Array<number | null>(n).fill(null);
  if (n < period) {
    return out;
  }
  const trs: number[] = new Array<number>(n).fill(0);
  let prevClose: number | null = null;
  for (let i = 0; i < n; i += 1) {
    const bar = bars[i];
    if (bar === undefined) {
      continue;
    }
    trs[i] = trueRange(bar, prevClose);
    prevClose = bar.close;
  }
  let sum = 0;
  for (let i = 0; i < period; i += 1) {
    sum += trs[i] ?? 0;
  }
  let cur = sum / period;
  out[period - 1] = cur;
  for (let i = period; i < n; i += 1) {
    cur = ((period - 1) * cur + (trs[i] ?? 0)) / period;
    out[i] = cur;
  }
  return out;
}

export class StreamingAtr implements StreamingIndicator<OhlcvBar, number> {
  private prevClose: number | null = null;
  private seedSum = 0;
  private seedCount = 0;
  private last: number | null = null;
  private seen = 0;

  constructor(private readonly period: number) {
    if (period < 1) {
      throw new Error("StreamingAtr: period must be >= 1");
    }
  }

  update(bar: OhlcvBar): number | null {
    this.seen += 1;
    const tr = trueRange(bar, this.prevClose);
    this.prevClose = bar.close;
    if (this.seedCount < this.period) {
      this.seedSum += tr;
      this.seedCount += 1;
      if (this.seedCount === this.period) {
        this.last = this.seedSum / this.period;
        return this.last;
      }
      return null;
    }
    const prev = this.last ?? tr;
    this.last = ((this.period - 1) * prev + tr) / this.period;
    return this.last;
  }

  get value(): number | null {
    return this.last;
  }

  get samplesSeen(): number {
    return this.seen;
  }
}
