/**
 * Bollinger Bands.
 *
 *   middle = SMA(period)
 *   stddev = population stddev of the trailing `period` values
 *   upper  = middle + stdDevs * stddev
 *   lower  = middle - stdDevs * stddev
 *
 * Uses population (not sample) standard deviation — the standard Bollinger
 * Bands definition. Returns null entries during the warm-up window.
 */

import type { StreamingIndicator } from "./types.js";

export interface BollingerPoint {
  middle: number;
  upper: number;
  lower: number;
  stddev: number;
}

export function bollingerBands(
  values: readonly number[],
  period: number,
  stdDevs: number,
): Array<BollingerPoint | null> {
  if (period < 1) {
    throw new Error("bollingerBands: period must be >= 1");
  }
  if (stdDevs <= 0) {
    throw new Error("bollingerBands: stdDevs must be > 0");
  }
  const n = values.length;
  const out: Array<BollingerPoint | null> = new Array<BollingerPoint | null>(n).fill(null);
  if (n < period) {
    return out;
  }
  for (let i = period - 1; i < n; i += 1) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      sum += values[j] ?? 0;
    }
    const mean = sum / period;
    let sqSum = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const d = (values[j] ?? 0) - mean;
      sqSum += d * d;
    }
    const stddev = Math.sqrt(sqSum / period);
    out[i] = {
      middle: mean,
      upper: mean + stdDevs * stddev,
      lower: mean - stdDevs * stddev,
      stddev,
    };
  }
  return out;
}

export class StreamingBollinger
  implements StreamingIndicator<number, BollingerPoint>
{
  private readonly buf: number[];
  private idx = 0;
  private filled = 0;
  private last: BollingerPoint | null = null;
  private seen = 0;

  constructor(
    private readonly period: number,
    private readonly stdDevs: number,
  ) {
    if (period < 1) {
      throw new Error("StreamingBollinger: period must be >= 1");
    }
    if (stdDevs <= 0) {
      throw new Error("StreamingBollinger: stdDevs must be > 0");
    }
    this.buf = new Array<number>(period).fill(0);
  }

  update(x: number): BollingerPoint | null {
    this.seen += 1;
    this.buf[this.idx] = x;
    this.idx = (this.idx + 1) % this.period;
    if (this.filled < this.period) {
      this.filled += 1;
    }
    if (this.filled < this.period) {
      return null;
    }
    let sum = 0;
    for (let i = 0; i < this.period; i += 1) {
      sum += this.buf[i] ?? 0;
    }
    const mean = sum / this.period;
    let sqSum = 0;
    for (let i = 0; i < this.period; i += 1) {
      const d = (this.buf[i] ?? 0) - mean;
      sqSum += d * d;
    }
    const stddev = Math.sqrt(sqSum / this.period);
    this.last = {
      middle: mean,
      upper: mean + this.stdDevs * stddev,
      lower: mean - this.stdDevs * stddev,
      stddev,
    };
    return this.last;
  }

  get value(): BollingerPoint | null {
    return this.last;
  }

  get samplesSeen(): number {
    return this.seen;
  }
}
