/**
 * Monte Carlo trade reshuffling per spec §8.5.
 *
 * Shuffle the trade sequence with replacement-free permutations 1000+
 * times. For each permutation compute:
 *   - final equity
 *   - max drawdown $
 *   - longest losing streak (consecutive losing trades)
 *
 * Report 5/50/95 percentiles of each. Seeded RNG.
 */

import { mulberry32, type SeededRng } from "@trading/core";

import type { ClosedTrade } from "./equity-curve.js";
import { percentile } from "./stats.js";

export interface MonteCarloOutcome {
  finalEquity: { p5: number; p50: number; p95: number };
  maxDrawdownUsd: { p5: number; p50: number; p95: number };
  longestLosingStreak: { p5: number; p50: number; p95: number };
  shuffles: number;
}

/** Fisher–Yates in place using the seeded RNG. */
function shuffle<T>(xs: T[], rng: SeededRng): void {
  for (let i = xs.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(0, i + 1);
    const tmp = xs[i] as T;
    xs[i] = xs[j] as T;
    xs[j] = tmp;
  }
}

function longestLosingStreak(trades: readonly ClosedTrade[]): number {
  let cur = 0;
  let best = 0;
  for (const t of trades) {
    if (t.realizedPnLUsd < 0) {
      cur += 1;
      if (cur > best) {
        best = cur;
      }
    } else {
      cur = 0;
    }
  }
  return best;
}

function maxDdUsdFromSequence(
  initialEquity: number,
  trades: readonly ClosedTrade[],
): number {
  let equity = initialEquity;
  let peak = equity;
  let maxDd = 0;
  for (const t of trades) {
    equity += t.realizedPnLUsd;
    if (equity > peak) {
      peak = equity;
    }
    const dd = equity - peak;
    if (dd < maxDd) {
      maxDd = dd;
    }
  }
  return maxDd;
}

export interface MonteCarloArgs {
  initialEquityUsd: number;
  trades: readonly ClosedTrade[];
  shuffles?: number;
  rng?: SeededRng;
  seed?: number;
}

export function monteCarloShuffle(args: MonteCarloArgs): MonteCarloOutcome {
  const N = args.shuffles ?? 1000;
  const rng = args.rng ?? mulberry32(args.seed ?? 42);
  const finalEquities: number[] = new Array<number>(N);
  const maxDds: number[] = new Array<number>(N);
  const streaks: number[] = new Array<number>(N);
  const seq: ClosedTrade[] = [...args.trades];
  for (let i = 0; i < N; i += 1) {
    shuffle(seq, rng);
    let eq = args.initialEquityUsd;
    for (const t of seq) {
      eq += t.realizedPnLUsd;
    }
    finalEquities[i] = eq;
    maxDds[i] = maxDdUsdFromSequence(args.initialEquityUsd, seq);
    streaks[i] = longestLosingStreak(seq);
  }
  return {
    finalEquity: {
      p5: percentile(finalEquities, 0.05),
      p50: percentile(finalEquities, 0.5),
      p95: percentile(finalEquities, 0.95),
    },
    maxDrawdownUsd: {
      p5: percentile(maxDds, 0.05),
      p50: percentile(maxDds, 0.5),
      p95: percentile(maxDds, 0.95),
    },
    longestLosingStreak: {
      p5: percentile(streaks, 0.05),
      p50: percentile(streaks, 0.5),
      p95: percentile(streaks, 0.95),
    },
    shuffles: N,
  };
}
