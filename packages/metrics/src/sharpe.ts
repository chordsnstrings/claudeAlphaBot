/**
 * Sharpe + Sortino + Calmar.
 *
 * Sharpe   = sqrt(periods_per_year) * mean(returns - rf) / stddev(returns - rf)
 * Sortino  = sqrt(periods_per_year) * mean(returns - rf) / downside_stddev
 * Calmar   = CAGR / |max_drawdown_pct|
 *
 * Bootstrap CI per spec §8.3: resample daily returns with replacement
 * 1000+ times, compute Sharpe per resample, report 2.5/97.5 percentiles.
 */

import { mulberry32, type SeededRng } from "@trading/core";

import { mean, stddev, downsideStddev, percentile } from "./stats.js";

export interface SharpeArgs {
  /** Per-period returns (e.g. daily). */
  returns: readonly number[];
  /** Risk-free rate matching the period; default 0. */
  riskFreePerPeriod?: number;
  /** Annualisation factor; 252 trading days by default. */
  periodsPerYear?: number;
}

export interface SharpeResult {
  sharpe: number;
  sortino: number;
  /** Annualised mean excess return. */
  annualisedExcessReturn: number;
  /** Annualised volatility. */
  annualisedVol: number;
}

export function sharpeSortino(args: SharpeArgs): SharpeResult {
  const rf = args.riskFreePerPeriod ?? 0;
  const py = args.periodsPerYear ?? 252;
  const excess = args.returns.map((r) => r - rf);
  if (excess.length < 2) {
    return {
      sharpe: 0,
      sortino: 0,
      annualisedExcessReturn: 0,
      annualisedVol: 0,
    };
  }
  const m = mean(excess);
  const sd = stddev(excess);
  const dsd = downsideStddev(excess, 0);
  const ann = m * py;
  const annVol = sd * Math.sqrt(py);
  return {
    sharpe: sd === 0 ? 0 : (m / sd) * Math.sqrt(py),
    sortino: dsd === 0 ? 0 : (m / dsd) * Math.sqrt(py),
    annualisedExcessReturn: ann,
    annualisedVol: annVol,
  };
}

export interface BootstrapCi {
  point: number;
  lower: number;
  upper: number;
  resamples: number;
}

/**
 * 95% bootstrap CI for Sharpe. Resample returns with replacement
 * `resamples` times, compute Sharpe per resample, report the 2.5/97.5
 * percentiles. Uses an injected SeededRng so a session can replay.
 */
export function bootstrapSharpeCi(
  returns: readonly number[],
  args: {
    rng?: SeededRng;
    resamples?: number;
    periodsPerYear?: number;
    riskFreePerPeriod?: number;
    seed?: number;
  } = {},
): BootstrapCi {
  const rng = args.rng ?? mulberry32(args.seed ?? 42);
  const N = args.resamples ?? 1000;
  const py = args.periodsPerYear ?? 252;
  const rf = args.riskFreePerPeriod ?? 0;
  if (returns.length < 2) {
    return { point: 0, lower: 0, upper: 0, resamples: 0 };
  }
  const point = sharpeSortino({
    returns,
    periodsPerYear: py,
    riskFreePerPeriod: rf,
  }).sharpe;
  const samples: number[] = new Array<number>(N);
  for (let i = 0; i < N; i += 1) {
    const draw: number[] = new Array<number>(returns.length);
    for (let j = 0; j < returns.length; j += 1) {
      const idx = rng.nextInt(0, returns.length);
      draw[j] = returns[idx] ?? 0;
    }
    samples[i] = sharpeSortino({
      returns: draw,
      periodsPerYear: py,
      riskFreePerPeriod: rf,
    }).sharpe;
  }
  return {
    point,
    lower: percentile(samples, 0.025),
    upper: percentile(samples, 0.975),
    resamples: N,
  };
}

/** Calmar = CAGR / |max_drawdown_pct|. Returns 0 if drawdown is 0. */
export function calmar(cagr_: number, maxDdPct: number): number {
  if (maxDdPct === 0) {
    return 0;
  }
  return cagr_ / Math.abs(maxDdPct);
}
