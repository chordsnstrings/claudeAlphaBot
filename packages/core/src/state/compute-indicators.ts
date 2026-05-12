/**
 * Compute the full IndicatorSnapshot from a trailing window of bars.
 *
 * Used by the TradingSystem each bar to assemble MarketState before
 * dispatching to strategies. The batch indicators from Phase 4 are O(n)
 * each and fast enough that recomputation on a 500-bar window is well
 * inside the per-bar budget (Phase 4 perf: ~12 ms for all six on 1000
 * bars).
 */

import {
  adx,
  atr,
  atrPercentile,
  bollingerBands,
  ema,
  pastReturn,
  rollingHigh,
  rollingLow,
  rsi,
  sma,
} from "../indicators/index.js";
import type { Bar } from "../types/bar.js";
import type { IndicatorSnapshot } from "../types/market-state.js";

function last<T>(xs: ReadonlyArray<T | null>): T | null {
  if (xs.length === 0) {
    return null;
  }
  return xs[xs.length - 1] ?? null;
}

export function computeIndicators(bars: readonly Bar[]): IndicatorSnapshot {
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);

  const atr14arr = atr(bars, 14);
  const atr20arr = atr(bars, 20);
  const adx14arr = adx(bars, 14);

  return {
    atr14: last(atr14arr),
    atr20: last(atr20arr),
    adx14: last(adx14arr),
    sma20: last(sma(closes, 20)),
    sma50: last(sma(closes, 50)),
    sma100: last(sma(closes, 100)),
    sma200: last(sma(closes, 200)),
    ema20: last(ema(closes, 20)),
    ema50: last(ema(closes, 50)),
    rsi14: last(rsi(closes, 14)),
    bb20: last(bollingerBands(closes, 20, 2)),
    atrPercentile60: last(atrPercentile(atr14arr, 60)),
    pastReturn252: last(pastReturn(closes, 252)),
    rollingHigh20: last(rollingHigh(highs, 20)),
    rollingHigh55: last(rollingHigh(highs, 55)),
    rollingLow20: last(rollingLow(lows, 20)),
    rollingLow55: last(rollingLow(lows, 55)),
  };
}
