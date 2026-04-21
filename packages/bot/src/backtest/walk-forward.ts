/**
 * Walk-forward validation per spec §8.8 + §8.11.1 Stage 3.
 *
 * Rolling train/test windows:
 *   - train window: 6 months (default 180 days)
 *   - test window:  2 months (default 60 days)
 *   - step:         test_window (non-overlapping test windows)
 *
 * For each window, the caller provides a `trainFn` that picks the
 * best parameter set from the training candles, then we run the
 * bot on the test candles with those parameters and record metrics.
 *
 * The walk-forward module is intentionally AGNOSTIC of parameter
 * shape — `trainFn(candles) → ParamSet` and `backtestFn(candles, params)
 * → { sharpe, maxDdPct, trades }` are provided by the caller. This
 * keeps the module pure and trivially testable.
 *
 * Pass criteria per spec §8.11.1:
 *   - avg_test_sharpe > 1.0
 *   - train_to_test_ratio > 0.6
 *   - param_stability: max deviation of winning params across windows < 15%
 */
import type { Candle } from "@hydra/shared";

const DAY_MS = 86_400_000;

export const DEFAULT_WF_TRAIN_DAYS = 180;
export const DEFAULT_WF_TEST_DAYS = 60;

export interface WalkForwardWindow<P> {
  readonly trainStart: number;
  readonly trainEnd: number;
  readonly testStart: number;
  readonly testEnd: number;
  readonly params: P;
  readonly trainSharpe: number;
  readonly testSharpe: number;
  readonly testMaxDdPct: number;
  readonly testTrades: number;
}

export interface WalkForwardSummary<P> {
  readonly windows: readonly WalkForwardWindow<P>[];
  readonly avgTestSharpe: number;
  readonly avgTrainSharpe: number;
  readonly trainToTestRatio: number;
  readonly paramStabilityMaxDeviationPct: number;
}

export interface TrainResult {
  readonly sharpe: number;
}

export interface BacktestResult {
  readonly sharpe: number;
  readonly maxDdPct: number;
  readonly trades: number;
}

export interface WalkForwardOptions<P> {
  readonly trainDays?: number;
  readonly testDays?: number;
  readonly trainFn: (candles: readonly Candle[]) => { params: P; result: TrainResult };
  readonly backtestFn: (candles: readonly Candle[], params: P) => BacktestResult;
}

/** Slice candles into [trainStart, trainEnd) windows + [testStart, testEnd). */
export function* generateWalkForwardWindows(
  startMs: number,
  endMs: number,
  trainDays: number,
  testDays: number,
): Generator<{ trainStart: number; trainEnd: number; testStart: number; testEnd: number }> {
  const trainMs = trainDays * DAY_MS;
  const testMs = testDays * DAY_MS;
  let trainStart = startMs;
  while (trainStart + trainMs + testMs <= endMs) {
    const trainEnd = trainStart + trainMs;
    const testStart = trainEnd;
    const testEnd = testStart + testMs;
    yield { trainStart, trainEnd, testStart, testEnd };
    trainStart += testMs; // non-overlapping test windows
  }
}

export function runWalkForward<P>(
  candles: readonly Candle[],
  opts: WalkForwardOptions<P>,
): WalkForwardSummary<P> {
  if (candles.length === 0) {
    return {
      windows: [],
      avgTestSharpe: 0,
      avgTrainSharpe: 0,
      trainToTestRatio: 0,
      paramStabilityMaxDeviationPct: 0,
    };
  }
  const trainDays = opts.trainDays ?? DEFAULT_WF_TRAIN_DAYS;
  const testDays = opts.testDays ?? DEFAULT_WF_TEST_DAYS;
  const firstT = candles[0]!.openTime;
  const lastT = candles[candles.length - 1]!.openTime;

  const windows: WalkForwardWindow<P>[] = [];
  for (const w of generateWalkForwardWindows(firstT, lastT, trainDays, testDays)) {
    const trainCandles = candles.filter(
      (c) => c.openTime >= w.trainStart && c.openTime < w.trainEnd,
    );
    const testCandles = candles.filter(
      (c) => c.openTime >= w.testStart && c.openTime < w.testEnd,
    );
    if (trainCandles.length === 0 || testCandles.length === 0) continue;
    const train = opts.trainFn(trainCandles);
    const test = opts.backtestFn(testCandles, train.params);
    windows.push({
      trainStart: w.trainStart,
      trainEnd: w.trainEnd,
      testStart: w.testStart,
      testEnd: w.testEnd,
      params: train.params,
      trainSharpe: train.result.sharpe,
      testSharpe: test.sharpe,
      testMaxDdPct: test.maxDdPct,
      testTrades: test.trades,
    });
  }

  if (windows.length === 0) {
    return {
      windows: [],
      avgTestSharpe: 0,
      avgTrainSharpe: 0,
      trainToTestRatio: 0,
      paramStabilityMaxDeviationPct: 0,
    };
  }

  const avgTestSharpe =
    windows.reduce((s, w) => s + w.testSharpe, 0) / windows.length;
  const avgTrainSharpe =
    windows.reduce((s, w) => s + w.trainSharpe, 0) / windows.length;
  const trainToTestRatio =
    avgTrainSharpe > 0 ? avgTestSharpe / avgTrainSharpe : 0;
  const paramStabilityMaxDeviationPct = paramStability(windows.map((w) => w.params));

  return {
    windows,
    avgTestSharpe,
    avgTrainSharpe,
    trainToTestRatio,
    paramStabilityMaxDeviationPct,
  };
}

/**
 * Parameter stability: max pct deviation of any numeric param from its
 * mean across windows. Non-numeric params are ignored. Returns 0 when
 * there are fewer than 2 windows or no numeric params.
 */
export function paramStability(paramSets: readonly unknown[]): number {
  if (paramSets.length < 2) return 0;
  const numericKeys = new Map<string, number[]>();
  for (const p of paramSets) {
    if (p === null || typeof p !== "object") continue;
    for (const [k, v] of Object.entries(p)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        const arr = numericKeys.get(k) ?? [];
        arr.push(v);
        numericKeys.set(k, arr);
      }
    }
  }
  let maxDev = 0;
  for (const [, values] of numericKeys) {
    if (values.length < 2) continue;
    const mean = values.reduce((s, x) => s + x, 0) / values.length;
    if (mean === 0) continue;
    for (const v of values) {
      const dev = Math.abs((v - mean) / mean) * 100;
      if (dev > maxDev) maxDev = dev;
    }
  }
  return maxDev;
}

export interface WalkForwardPassCriteria {
  readonly minAvgTestSharpe?: number;
  readonly minTrainToTestRatio?: number;
  readonly maxParamStabilityDeviationPct?: number;
}

export const DEFAULT_WF_CRITERIA: Required<WalkForwardPassCriteria> = {
  minAvgTestSharpe: 1.0,
  minTrainToTestRatio: 0.6,
  maxParamStabilityDeviationPct: 15,
};

export function passesWalkForwardGate<P>(
  summary: WalkForwardSummary<P>,
  criteria: WalkForwardPassCriteria = {},
): { pass: boolean; failures: readonly string[] } {
  const c = { ...DEFAULT_WF_CRITERIA, ...criteria };
  const failures: string[] = [];
  if (summary.windows.length === 0) failures.push("no walk-forward windows produced");
  if (summary.avgTestSharpe <= c.minAvgTestSharpe) {
    failures.push(
      `avg_test_sharpe=${summary.avgTestSharpe.toFixed(3)} ≤ ${c.minAvgTestSharpe}`,
    );
  }
  if (summary.trainToTestRatio <= c.minTrainToTestRatio) {
    failures.push(
      `train_to_test_ratio=${summary.trainToTestRatio.toFixed(3)} ≤ ${c.minTrainToTestRatio}`,
    );
  }
  if (summary.paramStabilityMaxDeviationPct >= c.maxParamStabilityDeviationPct) {
    failures.push(
      `param_stability=${summary.paramStabilityMaxDeviationPct.toFixed(2)}% ≥ ${c.maxParamStabilityDeviationPct}%`,
    );
  }
  return { pass: failures.length === 0, failures };
}
