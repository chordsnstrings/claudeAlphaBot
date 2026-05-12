/**
 * Average Directional Movement Index (Wilder, 1978).
 *
 *   upMove   = High_t - High_{t-1}
 *   downMove = Low_{t-1} - Low_t
 *
 *   +DM = (upMove   > downMove && upMove   > 0) ? upMove   : 0
 *   -DM = (downMove > upMove   && downMove > 0) ? downMove : 0
 *
 *   TR uses the standard ATR true range.
 *
 *   All three series (+DM, -DM, TR) are Wilder-smoothed over the period:
 *     seed_N = sum over bars 1..N
 *     value_t = value_{t-1} - value_{t-1}/N + raw_t           (Wilder)
 *
 *   +DI = 100 * smoothed +DM / smoothed TR
 *   -DI = 100 * smoothed -DM / smoothed TR
 *   DX  = 100 * |+DI - -DI| / (+DI + -DI)
 *   ADX = Wilder-smoothed DX over the period
 *
 * The first ADX value is therefore available at index 2*period - 1.
 */

import { trueRange } from "./atr.js";
import type { OhlcvBar, StreamingIndicator } from "./types.js";

export interface AdxPoint {
  plusDi: number;
  minusDi: number;
  adx: number;
}

interface DmTr {
  plusDm: number;
  minusDm: number;
  tr: number;
}

function directionalMovement(prev: OhlcvBar, cur: OhlcvBar): DmTr {
  const upMove = cur.high - prev.high;
  const downMove = prev.low - cur.low;
  const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
  const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
  const tr = trueRange(cur, prev.close);
  return { plusDm, minusDm, tr };
}

export function adx(
  bars: readonly OhlcvBar[],
  period: number,
): Array<AdxPoint | null> {
  if (period < 1) {
    throw new Error("adx: period must be >= 1");
  }
  const n = bars.length;
  const out: Array<AdxPoint | null> = new Array<AdxPoint | null>(n).fill(null);
  if (n < 2 * period) {
    return out;
  }

  // Compute per-bar raw +DM, -DM, TR for bars 1..n-1 (bar 0 has no prev).
  const raws: DmTr[] = new Array<DmTr>(n);
  raws[0] = { plusDm: 0, minusDm: 0, tr: 0 };
  for (let i = 1; i < n; i += 1) {
    const prev = bars[i - 1];
    const cur = bars[i];
    if (prev === undefined || cur === undefined) {
      raws[i] = { plusDm: 0, minusDm: 0, tr: 0 };
      continue;
    }
    raws[i] = directionalMovement(prev, cur);
  }

  // Seed Wilder sums over bars 1..period.
  let sPlusDm = 0;
  let sMinusDm = 0;
  let sTr = 0;
  for (let i = 1; i <= period; i += 1) {
    const r = raws[i];
    if (r === undefined) {
      continue;
    }
    sPlusDm += r.plusDm;
    sMinusDm += r.minusDm;
    sTr += r.tr;
  }

  // Track DX values so we can later seed ADX from the first `period` of them.
  const dxBuf: number[] = [];

  function recordDx(idx: number): void {
    const plusDi = sTr === 0 ? 0 : (100 * sPlusDm) / sTr;
    const minusDi = sTr === 0 ? 0 : (100 * sMinusDm) / sTr;
    const sumDi = plusDi + minusDi;
    const dx = sumDi === 0 ? 0 : (100 * Math.abs(plusDi - minusDi)) / sumDi;
    dxBuf.push(dx);
    if (dxBuf.length === period) {
      // First ADX = mean of first `period` DX values.
      const adxSeed = dxBuf.reduce((a, b) => a + b, 0) / period;
      out[idx] = { plusDi, minusDi, adx: adxSeed };
    } else if (dxBuf.length > period) {
      const prev = out[idx - 1];
      // prev is non-null once we've passed the seed point.
      const prevAdx = prev?.adx ?? 0;
      const newAdx = ((period - 1) * prevAdx + dx) / period;
      out[idx] = { plusDi, minusDi, adx: newAdx };
    }
    // dxBuf.length < period -> ADX not yet available; skip (out[idx] stays null).
  }

  // Index period is the first one where the seeded smoothed sums exist.
  recordDx(period);

  for (let i = period + 1; i < n; i += 1) {
    const r = raws[i];
    if (r === undefined) {
      continue;
    }
    sPlusDm = sPlusDm - sPlusDm / period + r.plusDm;
    sMinusDm = sMinusDm - sMinusDm / period + r.minusDm;
    sTr = sTr - sTr / period + r.tr;
    recordDx(i);
  }
  return out;
}

export class StreamingAdx implements StreamingIndicator<OhlcvBar, AdxPoint> {
  private prev: OhlcvBar | null = null;
  private seedPlusDm = 0;
  private seedMinusDm = 0;
  private seedTr = 0;
  private seedCount = 0;
  private sPlusDm: number | null = null;
  private sMinusDm: number | null = null;
  private sTr: number | null = null;
  private dxBuf: number[] = [];
  private last: AdxPoint | null = null;
  private seen = 0;

  constructor(private readonly period: number) {
    if (period < 1) {
      throw new Error("StreamingAdx: period must be >= 1");
    }
  }

  update(bar: OhlcvBar): AdxPoint | null {
    this.seen += 1;
    const prev = this.prev;
    this.prev = bar;
    if (prev === null) {
      return null;
    }
    const r = directionalMovement(prev, bar);

    if (this.sTr === null) {
      this.seedPlusDm += r.plusDm;
      this.seedMinusDm += r.minusDm;
      this.seedTr += r.tr;
      this.seedCount += 1;
      if (this.seedCount < this.period) {
        return null;
      }
      this.sPlusDm = this.seedPlusDm;
      this.sMinusDm = this.seedMinusDm;
      this.sTr = this.seedTr;
    } else {
      this.sPlusDm = (this.sPlusDm ?? 0) - (this.sPlusDm ?? 0) / this.period + r.plusDm;
      this.sMinusDm = (this.sMinusDm ?? 0) - (this.sMinusDm ?? 0) / this.period + r.minusDm;
      this.sTr = this.sTr - this.sTr / this.period + r.tr;
    }

    const plusDi = this.sTr === 0 ? 0 : (100 * (this.sPlusDm ?? 0)) / this.sTr;
    const minusDi = this.sTr === 0 ? 0 : (100 * (this.sMinusDm ?? 0)) / this.sTr;
    const sumDi = plusDi + minusDi;
    const dx = sumDi === 0 ? 0 : (100 * Math.abs(plusDi - minusDi)) / sumDi;
    this.dxBuf.push(dx);

    if (this.dxBuf.length < this.period) {
      return null;
    }
    if (this.dxBuf.length === this.period) {
      const adxSeed = this.dxBuf.reduce((a, b) => a + b, 0) / this.period;
      this.last = { plusDi, minusDi, adx: adxSeed };
      return this.last;
    }
    const prevAdx = this.last?.adx ?? 0;
    const newAdx = ((this.period - 1) * prevAdx + dx) / this.period;
    this.last = { plusDi, minusDi, adx: newAdx };
    return this.last;
  }

  get value(): AdxPoint | null {
    return this.last;
  }

  get samplesSeen(): number {
    return this.seen;
  }
}
