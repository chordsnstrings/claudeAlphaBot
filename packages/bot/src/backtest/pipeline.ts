/**
 * Validation pipeline orchestrator per spec §8.11.1.
 *
 * Runs 5 stages in sequence:
 *   1. Parameter sweep backtest (combinations × strategies)
 *   2. Monte Carlo (top 20 by Sharpe)
 *   3. Walk-forward (top 10 of MC passers)
 *   4. Out-of-sample hold-out
 *   5. Composite-score best-performer selection
 *
 * Produces a `validated_config.json` artifact per spec §8.11.2.
 *
 * Callers supply:
 *   - `paramSweep: readonly ParamSet[]` — the combinations to try
 *   - `backtestFn(candles, params) → { trades, report, equityCurve }`
 *   - Training/OOS candle slices
 *
 * If the pipeline cannot find a passing parameter set at any stage,
 * the artifact is still emitted with `deploymentAllowed: false` and
 * `deploymentBlockers` populated with stage-by-stage diagnosis.
 */
import type {
  BacktestSummary,
  MonteCarloSummary,
  OutOfSampleSummary,
  Symbol as TradingSymbol,
  Trade,
  ValidatedConfig,
  WalkForwardSummary as SpecWalkForwardSummary,
  WinningParameters,
} from "@hydra/shared";

import type { EquityPoint } from "./metrics.js";
import { buildReport } from "./metrics.js";
import {
  passesMonteCarloGate,
  runMonteCarlo,
  type MonteCarloPassCriteria,
} from "./monte-carlo.js";
import {
  passesWalkForwardGate,
  runWalkForward,
  type WalkForwardOptions,
  type WalkForwardPassCriteria,
  type WalkForwardSummary as InternalWfSummary,
} from "./walk-forward.js";

export const DEFAULT_TOP_MC = 20;
export const DEFAULT_TOP_WF = 10;

export interface StageBacktestResult {
  readonly trades: readonly Trade[];
  readonly equityCurve: readonly EquityPoint[];
  readonly sharpe: number;
  readonly maxDdPct: number;
  readonly totalReturnPct: number;
  readonly winRatePct: number;
  readonly profitFactor: number;
}

export interface PipelineInputs<P extends WinningParameters> {
  readonly paramSweep: readonly P[];
  readonly trainingCandles: import("@hydra/shared").Candle[];
  readonly oosCandles: import("@hydra/shared").Candle[];
  readonly backtestFn: (
    candles: readonly import("@hydra/shared").Candle[],
    params: P,
  ) => StageBacktestResult;
  readonly walkForwardOpts: Omit<WalkForwardOptions<P>, "backtestFn"> & {
    readonly trainFn: WalkForwardOptions<P>["trainFn"];
  };
  readonly symbols: readonly TradingSymbol[];
  readonly startingEquity: number;
  readonly codeHash: string;
  readonly nowUtc: number;
  readonly dataWindow: {
    readonly start: string;
    readonly end: string;
    readonly monthsCovered: number;
  };
  readonly mcCriteria?: MonteCarloPassCriteria;
  readonly wfCriteria?: WalkForwardPassCriteria;
  readonly mcRuns?: number;
  readonly topMc?: number;
  readonly topWf?: number;
}

export interface StageResult<P> {
  readonly params: P;
  readonly backtest: StageBacktestResult;
}

export interface PipelineDiagnostics {
  readonly sweepCount: number;
  readonly afterStage1: number;
  readonly afterStage2: number;
  readonly afterStage3: number;
  readonly afterStage4: number;
  readonly haltedAt: "NONE" | "SWEEP" | "MONTE_CARLO" | "WALK_FORWARD" | "OOS" | "SELECTION";
  readonly failures: readonly string[];
}

export interface PipelineResult<P extends WinningParameters> {
  readonly artifact: ValidatedConfig;
  readonly diagnostics: PipelineDiagnostics;
  readonly winner: StageResult<P> | null;
}

/** Composite score per spec §8.11.1 Stage 5. */
export function compositeScore(args: {
  readonly testSharpe: number;
  readonly oosSharpe: number;
  readonly monteCarloP5ReturnPct: number;
  readonly maxDrawdownPct: number;
  readonly parameterStabilityScore: number; // [0, 1]
  readonly tradeCount: number;
}): number {
  const ddTerm = (1 - Math.min(1, Math.max(0, args.maxDrawdownPct / 100))) * 0.15;
  const tcScore = Math.min(1, args.tradeCount / 200);
  return (
    args.testSharpe * 0.35 +
    args.oosSharpe * 0.25 +
    args.monteCarloP5ReturnPct * 0.002 +
    ddTerm +
    args.parameterStabilityScore * 0.15 +
    tcScore * 0.10
  );
}

export async function runValidationPipeline<P extends WinningParameters>(
  inputs: PipelineInputs<P>,
): Promise<PipelineResult<P>> {
  const failures: string[] = [];
  const topMc = inputs.topMc ?? DEFAULT_TOP_MC;
  const topWf = inputs.topWf ?? DEFAULT_TOP_WF;

  // --- Stage 1: full sweep on training candles ---
  const stage1: StageResult<P>[] = [];
  for (const params of inputs.paramSweep) {
    const r = inputs.backtestFn(inputs.trainingCandles, params);
    stage1.push({ params, backtest: r });
  }
  stage1.sort((a, b) => b.backtest.sharpe - a.backtest.sharpe);

  if (stage1.length === 0) {
    failures.push("stage 1: sweep produced 0 results (empty paramSweep)");
    return emitFailure(inputs, failures, "SWEEP", {
      sweepCount: 0,
      afterStage1: 0,
      afterStage2: 0,
      afterStage3: 0,
      afterStage4: 0,
    });
  }

  // --- Stage 2: Monte Carlo on top 20 ---
  const s2Candidates = stage1.slice(0, topMc);
  const s2Passers: Array<StageResult<P> & { mc: ReturnType<typeof runMonteCarlo> }> = [];
  for (const c of s2Candidates) {
    const mc = runMonteCarlo({
      trades: c.backtest.trades,
      startingEquity: inputs.startingEquity,
      ...(inputs.mcRuns !== undefined ? { opts: { runs: inputs.mcRuns } } : {}),
    });
    const gate = passesMonteCarloGate(mc, inputs.mcCriteria);
    if (gate.pass) s2Passers.push({ ...c, mc });
  }
  if (s2Passers.length === 0) {
    failures.push(
      `stage 2: Monte Carlo rejected all ${s2Candidates.length} top candidates (criteria too strict for observed samples)`,
    );
    return emitFailure(inputs, failures, "MONTE_CARLO", {
      sweepCount: stage1.length,
      afterStage1: s2Candidates.length,
      afterStage2: 0,
      afterStage3: 0,
      afterStage4: 0,
    });
  }

  // --- Stage 3: walk-forward on top 10 MC passers ---
  const s3Candidates = s2Passers.slice(0, topWf);
  const s3Passers: Array<
    StageResult<P> & {
      mc: ReturnType<typeof runMonteCarlo>;
      wf: InternalWfSummary<P>;
    }
  > = [];
  for (const c of s3Candidates) {
    const wf = runWalkForward(inputs.trainingCandles, {
      ...inputs.walkForwardOpts,
      backtestFn: (candles, params) => {
        const r = inputs.backtestFn(candles, params);
        return { sharpe: r.sharpe, maxDdPct: r.maxDdPct, trades: r.trades.length };
      },
    });
    const gate = passesWalkForwardGate(wf, inputs.wfCriteria);
    if (gate.pass) s3Passers.push({ ...c, wf });
  }
  if (s3Passers.length === 0) {
    failures.push(
      `stage 3: walk-forward rejected all ${s3Candidates.length} MC passers (avg_test_sharpe or stability criteria not met)`,
    );
    return emitFailure(inputs, failures, "WALK_FORWARD", {
      sweepCount: stage1.length,
      afterStage1: s2Candidates.length,
      afterStage2: s2Passers.length,
      afterStage3: 0,
      afterStage4: 0,
    });
  }

  // --- Stage 4: OOS on WF passers ---
  const s4Passers: Array<
    StageResult<P> & {
      mc: ReturnType<typeof runMonteCarlo>;
      wf: InternalWfSummary<P>;
      oos: StageBacktestResult;
    }
  > = [];
  for (const c of s3Passers) {
    const oos = inputs.backtestFn(inputs.oosCandles, c.params);
    const wfAvgSharpe = c.wf.avgTestSharpe;
    const wfAvgMaxDd =
      c.wf.windows.length > 0
        ? c.wf.windows.reduce((s, w) => s + w.testMaxDdPct, 0) / c.wf.windows.length
        : 0;
    const sharpeOk = oos.sharpe >= 0.6 * wfAvgSharpe;
    const ddOk = oos.maxDdPct <= 1.3 * Math.max(wfAvgMaxDd, 0.5); // guard against 0
    if (sharpeOk && ddOk) s4Passers.push({ ...c, oos });
  }
  if (s4Passers.length === 0) {
    failures.push(
      `stage 4: OOS rejected all ${s3Passers.length} WF passers (oos_sharpe < 60% of wf avg or dd too high)`,
    );
    return emitFailure(inputs, failures, "OOS", {
      sweepCount: stage1.length,
      afterStage1: s2Candidates.length,
      afterStage2: s2Passers.length,
      afterStage3: s3Passers.length,
      afterStage4: 0,
    });
  }

  // --- Stage 5: composite score + select winner ---
  const scored = s4Passers.map((c) => {
    const paramStabilityScore = Math.max(
      0,
      1 - c.wf.paramStabilityMaxDeviationPct / 100,
    );
    const score = compositeScore({
      testSharpe: c.wf.avgTestSharpe,
      oosSharpe: c.oos.sharpe,
      monteCarloP5ReturnPct: c.mc.p5ReturnPct,
      maxDrawdownPct: Math.max(c.backtest.maxDdPct, c.oos.maxDdPct),
      parameterStabilityScore: paramStabilityScore,
      tradeCount: c.backtest.trades.length,
    });
    return { ...c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0]!;

  const artifact = emitArtifact({
    inputs,
    params: winner.params,
    trainingResult: winner.backtest,
    mc: winner.mc,
    wf: winner.wf,
    oos: winner.oos,
    score: winner.score,
    deploymentAllowed: true,
  });

  return {
    artifact,
    diagnostics: {
      sweepCount: stage1.length,
      afterStage1: s2Candidates.length,
      afterStage2: s2Passers.length,
      afterStage3: s3Passers.length,
      afterStage4: s4Passers.length,
      haltedAt: "NONE",
      failures: [],
    },
    winner: { params: winner.params, backtest: winner.backtest },
  };
}

function emitFailure<P extends WinningParameters>(
  inputs: PipelineInputs<P>,
  failures: readonly string[],
  haltedAt: PipelineDiagnostics["haltedAt"],
  counts: Omit<PipelineDiagnostics, "haltedAt" | "failures">,
): PipelineResult<P> {
  const empty: BacktestSummary = {
    totalReturnPct: 0,
    sharpe: 0,
    maxDdPct: 0,
    tradeCount: 0,
    winRatePct: 0,
    profitFactor: 0,
  };
  const artifact: ValidatedConfig = {
    artifactVersion: "1.0",
    createdAt: new Date(inputs.nowUtc).toISOString(),
    codeHash: inputs.codeHash,
    dataWindow: inputs.dataWindow,
    symbols: inputs.symbols,
    winningParameters: {},
    validationResults: {
      backtest: empty,
      monteCarlo: {
        runs: 0,
        medianReturnPct: 0,
        p5ReturnPct: 0,
        p95ReturnPct: 0,
        p95MaxDdPct: 0,
        probNegativeReturnPct: 0,
      },
      walkForward: {
        windowsTested: 0,
        avgTestSharpe: 0,
        trainToTestRatio: 0,
        paramStabilityMaxDeviationPct: 0,
      },
      outOfSample: {
        period: "",
        sharpe: 0,
        maxDdPct: 0,
        returnPct: 0,
      },
    },
    compositeScore: 0,
    deploymentAllowed: false,
    deploymentBlockers: failures,
  };
  return {
    artifact,
    diagnostics: { ...counts, haltedAt, failures },
    winner: null,
  };
}

function emitArtifact<P extends WinningParameters>(args: {
  inputs: PipelineInputs<P>;
  params: P;
  trainingResult: StageBacktestResult;
  mc: ReturnType<typeof runMonteCarlo>;
  wf: InternalWfSummary<P>;
  oos: StageBacktestResult;
  score: number;
  deploymentAllowed: boolean;
}): ValidatedConfig {
  const { inputs, params, trainingResult, mc, wf, oos } = args;
  const backtest: BacktestSummary = {
    totalReturnPct: trainingResult.totalReturnPct,
    sharpe: trainingResult.sharpe,
    maxDdPct: trainingResult.maxDdPct,
    tradeCount: trainingResult.trades.length,
    winRatePct: trainingResult.winRatePct,
    profitFactor: trainingResult.profitFactor,
  };
  const monteCarlo: MonteCarloSummary = {
    runs: mc.runs,
    medianReturnPct: mc.medianReturnPct,
    p5ReturnPct: mc.p5ReturnPct,
    p95ReturnPct: mc.p95ReturnPct,
    p95MaxDdPct: mc.p95MaxDdPct,
    probNegativeReturnPct: mc.probNegativeReturnPct,
  };
  const walkForward: SpecWalkForwardSummary = {
    windowsTested: wf.windows.length,
    avgTestSharpe: wf.avgTestSharpe,
    trainToTestRatio: wf.trainToTestRatio,
    paramStabilityMaxDeviationPct: wf.paramStabilityMaxDeviationPct,
  };
  const outOfSample: OutOfSampleSummary = {
    period: inputs.dataWindow.end,
    sharpe: oos.sharpe,
    maxDdPct: oos.maxDdPct,
    returnPct: oos.totalReturnPct,
  };
  return {
    artifactVersion: "1.0",
    createdAt: new Date(inputs.nowUtc).toISOString(),
    codeHash: inputs.codeHash,
    dataWindow: inputs.dataWindow,
    symbols: inputs.symbols,
    winningParameters: params,
    validationResults: { backtest, monteCarlo, walkForward, outOfSample },
    compositeScore: args.score,
    deploymentAllowed: args.deploymentAllowed,
  };
}

/** Compose a full report for the training sweep winner (for optional extra logging). */
export function reportFromStageResult(
  trades: readonly Trade[],
  equityCurve: readonly EquityPoint[],
  startingEquity: number,
): ReturnType<typeof buildReport> {
  return buildReport(trades, equityCurve, startingEquity);
}
