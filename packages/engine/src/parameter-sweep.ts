/**
 * Parameter sweep framework — spec §9.22 + §8.6.
 *
 * Cross-products a parameter grid into N child Session instances. The
 * runner doesn't own session execution (that requires strategy +
 * adapter wiring at the CLI layer); it provides:
 *
 *   - planSweepCombinations(grid)        cross-product generation
 *   - analyseSweep(parentSessionId, results)
 *       expectancy distribution, best-by-metric, plateau detection,
 *       Bonferroni-adjusted significance
 *
 * Bonferroni (spec §8.6): with N combinations tested, the per-test
 * significance threshold for 5% overall is 0.05 / N. Combinations
 * "passing" the unadjusted 0.05 but failing the Bonferroni threshold
 * are flagged as "within noise of N tested."
 */

export interface ParameterGrid {
  /** Strategy id for the sweep. */
  strategy: string;
  /** Instrument list (one combination per instrument × param tuple). */
  instruments: string[];
  /** Each key -> list of values to test. */
  parameters: Record<string, readonly (string | number | boolean)[]>;
  /** Date range applied to every combination. */
  from: Date;
  to: Date;
  /** Optional filter that drops invalid combos before they're queued. */
  isValid?: (combination: ParameterCombination) => boolean;
}

export interface ParameterCombination {
  index: number;
  strategy: string;
  instrument: string;
  parameters: Record<string, string | number | boolean>;
}

export interface SweepResult {
  combination: ParameterCombination;
  childSessionId: string;
  expectancyR: number;
  sharpe: number;
  tradeCount: number;
  /** Two-sided p-value of expectancy vs zero, e.g. from a t-test. */
  pValue: number;
}

export interface SweepSummary {
  parentSessionId: string;
  combinations: number;
  bonferroniThreshold: number;
  bestByExpectancy: SweepResult | null;
  bestBySharpe: SweepResult | null;
  /** Combinations with p < 0.05 unadjusted. */
  significantUnadjusted: SweepResult[];
  /** Combinations with p < 0.05/N (Bonferroni). */
  significantBonferroni: SweepResult[];
  /** Plateau: combinations within `plateauTol` of the best metric. */
  plateauBands: {
    expectancy: { center: number; members: SweepResult[] };
    sharpe: { center: number; members: SweepResult[] };
  };
}

export function planSweepCombinations(grid: ParameterGrid): ParameterCombination[] {
  if (grid.instruments.length === 0) {
    return [];
  }
  const paramNames = Object.keys(grid.parameters);
  // Cross-product over parameter values.
  const valueLists = paramNames.map((n) => grid.parameters[n] ?? []);
  const combos: Array<Record<string, string | number | boolean>> = [{}];
  for (let i = 0; i < paramNames.length; i += 1) {
    const name = paramNames[i];
    const values = valueLists[i];
    if (name === undefined || values === undefined || values.length === 0) {
      continue;
    }
    const next: Array<Record<string, string | number | boolean>> = [];
    for (const acc of combos) {
      for (const v of values) {
        next.push({ ...acc, [name]: v });
      }
    }
    combos.splice(0, combos.length, ...next);
  }
  const out: ParameterCombination[] = [];
  let idx = 0;
  for (const inst of grid.instruments) {
    for (const params of combos) {
      const combo: ParameterCombination = {
        index: idx,
        strategy: grid.strategy,
        instrument: inst,
        parameters: params,
      };
      if (grid.isValid !== undefined && !grid.isValid(combo)) {
        continue;
      }
      out.push({ ...combo, index: idx });
      idx += 1;
    }
  }
  return out;
}

/**
 * Best-by-metric, plateau detection, Bonferroni gating. `plateauTol`
 * is in absolute units of the metric (e.g. 0.1 R for expectancy).
 */
export function analyseSweep(
  parentSessionId: string,
  results: readonly SweepResult[],
  opts: { plateauTol?: number } = {},
): SweepSummary {
  const N = results.length;
  const bonferroniThreshold = N === 0 ? 0.05 : 0.05 / N;
  const plateauTol = opts.plateauTol ?? 0.05;

  let bestExp: SweepResult | null = null;
  let bestSharpe: SweepResult | null = null;
  for (const r of results) {
    if (bestExp === null || r.expectancyR > bestExp.expectancyR) {
      bestExp = r;
    }
    if (bestSharpe === null || r.sharpe > bestSharpe.sharpe) {
      bestSharpe = r;
    }
  }
  const expCenter = bestExp?.expectancyR ?? 0;
  const sharpeCenter = bestSharpe?.sharpe ?? 0;
  const expBand = results.filter((r) => Math.abs(r.expectancyR - expCenter) <= plateauTol);
  const sharpeBand = results.filter((r) => Math.abs(r.sharpe - sharpeCenter) <= plateauTol);

  return {
    parentSessionId,
    combinations: N,
    bonferroniThreshold,
    bestByExpectancy: bestExp,
    bestBySharpe: bestSharpe,
    significantUnadjusted: results.filter((r) => r.pValue < 0.05),
    significantBonferroni: results.filter((r) => r.pValue < bonferroniThreshold),
    plateauBands: {
      expectancy: { center: expCenter, members: expBand },
      sharpe: { center: sharpeCenter, members: sharpeBand },
    },
  };
}
