/**
 * Relative Strength Index (Wilder, 1978, page 65).
 *
 *   Change_t = Close_t - Close_{t-1}
 *   Gain_t   = max(Change_t, 0)
 *   Loss_t   = max(-Change_t, 0)
 *
 *   Seed AvgGain / AvgLoss = simple mean over the first `period` changes
 *   then Wilder-smoothed: AvgGain_t = ((N-1)*AvgGain_{t-1} + Gain_t) / N
 *
 *   RS  = AvgGain / AvgLoss
 *   RSI = 100 - 100 / (1 + RS)
 *
 * If AvgLoss is exactly zero, RSI = 100. If both are zero, RSI = 50 by
 * convention (no movement).
 */

import type { StreamingIndicator } from "./types.js";

function rsiFromAvg(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100;
  }
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function rsi(closes: readonly number[], period: number): Array<number | null> {
  if (period < 1) {
    throw new Error("rsi: period must be >= 1");
  }
  const n = closes.length;
  const out: Array<number | null> = new Array<number | null>(n).fill(null);
  // Need at least period+1 closes (one per change, plus the seed).
  if (n < period + 1) {
    return out;
  }
  let sumGain = 0;
  let sumLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const ch = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    if (ch > 0) {
      sumGain += ch;
    } else {
      sumLoss -= ch;
    }
  }
  let avgGain = sumGain / period;
  let avgLoss = sumLoss / period;
  out[period] = rsiFromAvg(avgGain, avgLoss);
  for (let i = period + 1; i < n; i += 1) {
    const ch = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = ((period - 1) * avgGain + gain) / period;
    avgLoss = ((period - 1) * avgLoss + loss) / period;
    out[i] = rsiFromAvg(avgGain, avgLoss);
  }
  return out;
}

export class StreamingRsi implements StreamingIndicator<number, number> {
  private prevClose: number | null = null;
  private seedGain = 0;
  private seedLoss = 0;
  private seedCount = 0; // counts changes consumed
  private avgGain: number | null = null;
  private avgLoss: number | null = null;
  private last: number | null = null;
  private seen = 0;

  constructor(private readonly period: number) {
    if (period < 1) {
      throw new Error("StreamingRsi: period must be >= 1");
    }
  }

  update(close: number): number | null {
    this.seen += 1;
    if (this.prevClose === null) {
      this.prevClose = close;
      return null;
    }
    const ch = close - this.prevClose;
    this.prevClose = close;
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;

    if (this.avgGain === null || this.avgLoss === null) {
      this.seedGain += gain;
      this.seedLoss += loss;
      this.seedCount += 1;
      if (this.seedCount === this.period) {
        this.avgGain = this.seedGain / this.period;
        this.avgLoss = this.seedLoss / this.period;
        this.last = rsiFromAvg(this.avgGain, this.avgLoss);
        return this.last;
      }
      return null;
    }
    this.avgGain = ((this.period - 1) * this.avgGain + gain) / this.period;
    this.avgLoss = ((this.period - 1) * this.avgLoss + loss) / this.period;
    this.last = rsiFromAvg(this.avgGain, this.avgLoss);
    return this.last;
  }

  get value(): number | null {
    return this.last;
  }

  get samplesSeen(): number {
    return this.seen;
  }
}
