// pool.ts — Breakout pool: concurrent 4h Donchian books (trend + ADX filtered),
// stop at ATR*2, target at 2:1, resolved on 1h bars. Bracket-based.

import { Bar, Book } from "./types";
import { CONFIG } from "./config";
import { closes, sma, atrFrac, adx, donchian } from "./indicators";

/** Detect Donchian breakouts on 4h, filtered by trend (SMA) and ADX.
 * Returns array of `{ at4hIndex, direction, stopFrac }` for each NEW signal. */
export function detectPoolSignals(bars4h: Bar[]) {
  const signals: Array<{
    at4hIndex: number;
    direction: 1 | -1;
    stopFrac: number;
  }> = [];

  const c = closes(bars4h);
  const trendSma = sma(c, CONFIG.POOL_SMA_TREND);
  const adxArr = adx(bars4h, 14);
  const atrf = atrFrac(bars4h, 14);

  for (const n of CONFIG.POOL_DONCH_LENGTHS) {
    const { low: dlow, high: dhigh } = donchian(bars4h, n);
    for (let i = Math.max(n, CONFIG.POOL_SMA_TREND); i < c.length; i++) {
      if (isNaN(trendSma[i]) || isNaN(adxArr[i]) || isNaN(atrf[i])) continue;
      if (adxArr[i] < CONFIG.POOL_ADX_MIN) continue;

      const stopFrac = atrf[i] * CONFIG.POOL_ATR_MULT;
      if (stopFrac <= 0) continue;

      // Long breakout: close >= prior N-bar high AND price > SMA (trend filter)
      if (!isNaN(dhigh[i]) && c[i] >= dhigh[i] && c[i] > trendSma[i]) {
        signals.push({ at4hIndex: i, direction: 1, stopFrac });
      }
      // Short breakout: close <= prior N-bar low AND price < SMA
      if (!isNaN(dlow[i]) && c[i] <= dlow[i] && c[i] < trendSma[i]) {
        signals.push({ at4hIndex: i, direction: -1, stopFrac });
      }
    }
  }
  return signals;
}

/** Open a book given a 4h-signal and a 1h-bar list. Returns the entry index in 1h bars, or null. */
export function openBookOn1h(
  signal: { at4hIndex: number; direction: 1 | -1; stopFrac: number },
  bars4h: Bar[],
  bars1h: Bar[],
  equity: number,
): Book | null {
  // Causal entry: the 4h bar's signal is known at its CLOSE (openMs + 4h).
  const entryTimeMs = bars4h[signal.at4hIndex].openMs + 4 * 3600 * 1000;
  // Find first 1h bar at or after entry time
  let entryIdx = -1;
  for (let j = 0; j < bars1h.length; j++) {
    if (bars1h[j].openMs >= entryTimeMs) {
      entryIdx = j;
      break;
    }
  }
  if (entryIdx < 0) return null;
  const entryPrice = bars1h[entryIdx].open;
  const dir = signal.direction;
  const stopPrice =
    dir > 0 ? entryPrice * (1 - signal.stopFrac) : entryPrice * (1 + signal.stopFrac);
  const targetPrice =
    dir > 0
      ? entryPrice * (1 + CONFIG.POOL_RR * signal.stopFrac)
      : entryPrice * (1 - CONFIG.POOL_RR * signal.stopFrac);
  // Size for risk = POOL_RISK_PER_BOOK of equity per book
  const riskDollars = CONFIG.POOL_RISK_PER_BOOK * equity;
  const stopDistPct = Math.abs(entryPrice - stopPrice) / entryPrice;
  const notional = stopDistPct > 0 ? riskDollars / stopDistPct : 0;
  if (notional <= 0) return null;
  return {
    donchN: 0,
    direction: dir,
    entryPrice,
    stopPrice,
    targetPrice,
    notional,
    openMs: bars1h[entryIdx].openMs,
  };
}

/** Check if a book's stop or target has hit between book.openMs and now. Returns the close info if hit. */
export function checkBookHit(
  book: Book,
  bars1h: Bar[],
): { hit: "stop" | "target" | null; bar?: Bar } {
  for (const bar of bars1h) {
    if (bar.openMs <= book.openMs) continue;
    if (book.direction > 0) {
      const stopHit = bar.low <= book.stopPrice;
      const tpHit = bar.high >= book.targetPrice;
      if (stopHit && tpHit) return { hit: "stop", bar }; // same-bar both -> conservative
      if (tpHit) return { hit: "target", bar };
      if (stopHit) return { hit: "stop", bar };
    } else {
      const stopHit = bar.high >= book.stopPrice;
      const tpHit = bar.low <= book.targetPrice;
      if (stopHit && tpHit) return { hit: "stop", bar };
      if (tpHit) return { hit: "target", bar };
      if (stopHit) return { hit: "stop", bar };
    }
  }
  return { hit: null };
}

/** Compute net pool position from a list of open books (as a fraction of equity). */
export function poolNetPosition(books: Book[], equity: number, latestPrice: number): number {
  let netNotional = 0;
  for (const b of books) {
    netNotional += b.direction * b.notional;
  }
  return equity > 0 ? netNotional / equity : 0;
}
