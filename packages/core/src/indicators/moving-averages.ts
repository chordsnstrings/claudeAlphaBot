/**
 * Simple Moving Average (SMA) and Exponential Moving Average (EMA).
 *
 * Both have batch + streaming forms. Batch returns an array the same length
 * as the input with `null` filling the warm-up indices. Streaming exposes
 * `update(value)` -> the new value (or null while warming).
 */

import type { StreamingIndicator } from "./types.js";

// ----------------------------- SMA --------------------------------------

export function sma(values: readonly number[], period: number): Array<number | null> {
  if (period < 1) {
    throw new Error("sma: period must be >= 1");
  }
  const out: Array<number | null> = new Array<number | null>(values.length).fill(null);
  if (values.length < period) {
    return out;
  }
  let sum = 0;
  for (let i = 0; i < period; i += 1) {
    sum += values[i] ?? 0;
  }
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i += 1) {
    sum += (values[i] ?? 0) - (values[i - period] ?? 0);
    out[i] = sum / period;
  }
  return out;
}

export class StreamingSma implements StreamingIndicator<number, number> {
  private readonly buf: number[];
  private idx = 0;
  private filled = 0;
  private sum = 0;
  private last: number | null = null;
  private seen = 0;

  constructor(private readonly period: number) {
    if (period < 1) {
      throw new Error("StreamingSma: period must be >= 1");
    }
    this.buf = new Array<number>(period).fill(0);
  }

  update(x: number): number | null {
    this.seen += 1;
    if (this.filled < this.period) {
      this.buf[this.idx] = x;
      this.sum += x;
      this.filled += 1;
    } else {
      const old = this.buf[this.idx] ?? 0;
      this.buf[this.idx] = x;
      this.sum += x - old;
    }
    this.idx = (this.idx + 1) % this.period;
    if (this.filled === this.period) {
      this.last = this.sum / this.period;
      return this.last;
    }
    return null;
  }

  get value(): number | null {
    return this.last;
  }

  get samplesSeen(): number {
    return this.seen;
  }
}

// ----------------------------- EMA --------------------------------------

/**
 * EMA seeded with SMA of the first `period` values, then
 *   EMA_t = alpha * x_t + (1 - alpha) * EMA_{t-1}
 * where alpha = 2 / (period + 1).
 */
export function ema(values: readonly number[], period: number): Array<number | null> {
  if (period < 1) {
    throw new Error("ema: period must be >= 1");
  }
  const out: Array<number | null> = new Array<number | null>(values.length).fill(null);
  if (values.length < period) {
    return out;
  }
  const alpha = 2 / (period + 1);
  // Seed with SMA of first `period` values.
  let sum = 0;
  for (let i = 0; i < period; i += 1) {
    sum += values[i] ?? 0;
  }
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    const v = values[i] ?? 0;
    prev = alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

export class StreamingEma implements StreamingIndicator<number, number> {
  private readonly alpha: number;
  private seedSum = 0;
  private seedCount = 0;
  private last: number | null = null;
  private seen = 0;

  constructor(private readonly period: number) {
    if (period < 1) {
      throw new Error("StreamingEma: period must be >= 1");
    }
    this.alpha = 2 / (period + 1);
  }

  update(x: number): number | null {
    this.seen += 1;
    if (this.seedCount < this.period) {
      this.seedSum += x;
      this.seedCount += 1;
      if (this.seedCount === this.period) {
        this.last = this.seedSum / this.period;
        return this.last;
      }
      return null;
    }
    const prev = this.last ?? x;
    this.last = this.alpha * x + (1 - this.alpha) * prev;
    return this.last;
  }

  get value(): number | null {
    return this.last;
  }

  get samplesSeen(): number {
    return this.seen;
  }
}
