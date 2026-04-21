/**
 * Monte Carlo trade-order randomization per spec §8.11.1 Stage 2.
 *
 * Given the trade list from a backtest, randomize the trade order
 * `runs` times (default 1000). For each permutation, replay the
 * *sequence* of pnlR values against the starting equity and build
 * an equity-curve proxy (one point per trade).
 *
 * The simulation is NOT a full re-backtest — it reuses the per-trade
 * outcomes and only changes their order. This isolates luck-of-draw:
 * the same trades, but in different sequences, produce different
 * drawdown profiles. A strategy that relies on a specific lucky
 * ordering will have wide p5–p95 dispersion.
 *
 * Pass criteria per spec:
 *   - prob_negative_return_pct < 10
 *   - p5_return_pct > 0
 *   - p95_max_dd_pct < 30
 */
import type { Trade } from "@hydra/shared";

export interface MonteCarloOptions {
  readonly runs?: number;
  readonly seed?: number;
}

export const DEFAULT_MC_RUNS = 1_000;

export interface MonteCarloStats {
  readonly runs: number;
  readonly medianReturnPct: number;
  readonly p5ReturnPct: number;
  readonly p95ReturnPct: number;
  readonly medianMaxDdPct: number;
  readonly p95MaxDdPct: number;
  readonly probNegativeReturnPct: number;
}

export interface MonteCarloInputs {
  readonly trades: readonly Trade[];
  readonly startingEquity: number;
  readonly opts?: MonteCarloOptions;
}

/** Seeded LCG — we want determinism in tests. */
export function lcg(seed: number): () => number {
  let s = (seed | 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    // Convert to a uniform in [0, 1)
    return ((s >>> 0) % 0xffffffff) / 0xffffffff;
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

function percentile(values: readonly number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (pct / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

/**
 * One permutation: walk the trades in given order, compounding pnlUsd
 * against starting equity. Return finalReturnPct + maxDdPct.
 */
function replaySequence(
  trades: readonly Trade[],
  startingEquity: number,
): { finalReturnPct: number; maxDdPct: number } {
  let equity = startingEquity;
  let peak = startingEquity;
  let maxDd = 0;
  for (const t of trades) {
    equity += t.pnlUsd;
    if (equity > peak) peak = equity;
    else if (peak > 0) {
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }
  const finalReturnPct =
    startingEquity > 0 ? ((equity - startingEquity) / startingEquity) * 100 : 0;
  return { finalReturnPct, maxDdPct: maxDd };
}

export function runMonteCarlo(inputs: MonteCarloInputs): MonteCarloStats {
  const runs = inputs.opts?.runs ?? DEFAULT_MC_RUNS;
  const rng = lcg(inputs.opts?.seed ?? 0xc0ffee);
  const returns: number[] = [];
  const maxDds: number[] = [];
  let negativeCount = 0;
  for (let i = 0; i < runs; i++) {
    const order = shuffle([...inputs.trades], rng);
    const r = replaySequence(order, inputs.startingEquity);
    returns.push(r.finalReturnPct);
    maxDds.push(r.maxDdPct);
    if (r.finalReturnPct < 0) negativeCount++;
  }
  return {
    runs,
    medianReturnPct: percentile(returns, 50),
    p5ReturnPct: percentile(returns, 5),
    p95ReturnPct: percentile(returns, 95),
    medianMaxDdPct: percentile(maxDds, 50),
    p95MaxDdPct: percentile(maxDds, 95),
    probNegativeReturnPct: runs > 0 ? (negativeCount / runs) * 100 : 0,
  };
}

export interface MonteCarloPassCriteria {
  readonly maxProbNegativePct?: number;
  readonly minP5ReturnPct?: number;
  readonly maxP95MaxDdPct?: number;
}

export const DEFAULT_MC_CRITERIA: Required<MonteCarloPassCriteria> = {
  maxProbNegativePct: 10,
  minP5ReturnPct: 0,
  maxP95MaxDdPct: 30,
};

export function passesMonteCarloGate(
  stats: MonteCarloStats,
  criteria: MonteCarloPassCriteria = {},
): { pass: boolean; failures: readonly string[] } {
  const c = { ...DEFAULT_MC_CRITERIA, ...criteria };
  const failures: string[] = [];
  if (stats.probNegativeReturnPct >= c.maxProbNegativePct) {
    failures.push(
      `prob_negative_return=${stats.probNegativeReturnPct.toFixed(2)}% ≥ ${c.maxProbNegativePct}%`,
    );
  }
  if (stats.p5ReturnPct <= c.minP5ReturnPct) {
    failures.push(
      `p5_return=${stats.p5ReturnPct.toFixed(2)}% ≤ ${c.minP5ReturnPct}%`,
    );
  }
  if (stats.p95MaxDdPct >= c.maxP95MaxDdPct) {
    failures.push(
      `p95_max_dd=${stats.p95MaxDdPct.toFixed(2)}% ≥ ${c.maxP95MaxDdPct}%`,
    );
  }
  return { pass: failures.length === 0, failures };
}
