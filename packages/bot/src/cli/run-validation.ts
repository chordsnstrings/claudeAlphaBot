/**
 * Validation pipeline CLI — spec §8.11.1.
 *
 * Usage:
 *   pnpm --filter bot validate-pipeline [--start=2024-04-01] [--end=2025-10-01]
 *                                        [--oos-months=3] [--mc-runs=1000]
 *                                        [--output=artifacts/validated_config.json]
 *                                        [--sparse] (fast dev mode)
 *
 * Reads candles from the `candles` table (filled by the `backfill`
 * CLI, Phase 4), splits into training + OOS windows, runs the five
 * pipeline stages, writes:
 *   - `artifacts/validated_config.json` (always — either passing or
 *     with `deploymentAllowed:false` + diagnostic blockers)
 *   - `artifacts/validation_snapshot.json` (per §8.12.1)
 *   - `VALIDATION_FAILED.md` if the gate was not passed (rubric
 *     requires this halts downstream phases).
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type {
  Candle,
  Symbol as TradingSymbol,
  Trade,
  ValidatedConfig,
  WinningParameters,
} from "@hydra/shared";
import { SYMBOLS } from "@hydra/shared";

import { loadEnv } from "../config/env.js";
import { closePool, getPool } from "../db/pool.js";
import { initLogger } from "../monitoring/logger.js";
import {
  evaluateArb,
  type ArbInputs,
} from "../core/signals-arb.js";
import { runReplay, type StrategyEvaluator } from "../backtest/replay-engine.js";
import type { EquityPoint } from "../backtest/metrics.js";
import { buildReport } from "../backtest/metrics.js";
import {
  runValidationPipeline,
  type PipelineInputs,
  type StageBacktestResult,
} from "../backtest/pipeline.js";
import { captureValidationSnapshot } from "../core/validation-snapshot.js";
import { atr as computeAtr } from "../core/indicators.js";

const DAY_MS = 86_400_000;

interface Args {
  start: string;
  end: string;
  oosMonths: number;
  mcRuns: number;
  output: string;
  sparse: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const now = new Date();
  const defaultEnd = now.toISOString().slice(0, 10);
  const defaultStart = new Date(now.getTime() - 540 * DAY_MS).toISOString().slice(0, 10);
  let start = defaultStart;
  let end = defaultEnd;
  let oosMonths = 3;
  let mcRuns = 1_000;
  let output = "artifacts/validated_config.json";
  let sparse = false;
  for (const a of argv) {
    if (a.startsWith("--start=")) start = a.slice("--start=".length);
    else if (a.startsWith("--end=")) end = a.slice("--end=".length);
    else if (a.startsWith("--oos-months=")) oosMonths = Number(a.slice("--oos-months=".length));
    else if (a.startsWith("--mc-runs=")) mcRuns = Number(a.slice("--mc-runs=".length));
    else if (a.startsWith("--output=")) output = a.slice("--output=".length);
    else if (a === "--sparse") sparse = true;
  }
  return { start, end, oosMonths, mcRuns, output, sparse };
}

async function loadCandles(
  startMs: number,
  endMs: number,
): Promise<Map<TradingSymbol, Candle[]>> {
  const pool = getPool();
  const byS = new Map<TradingSymbol, Candle[]>();
  for (const symbol of SYMBOLS) {
    const res = await pool.query<{
      open_time: string;
      close_time: string;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
    }>(
      `SELECT open_time::text, close_time::text, open::text, high::text, low::text,
              close::text, volume::text
         FROM candles
        WHERE symbol = $1 AND open_time >= $2 AND open_time < $3
        ORDER BY open_time ASC`,
      [symbol, startMs, endMs],
    );
    const rows: Candle[] = res.rows.map((r) => ({
      symbol,
      openTime: Number(r.open_time),
      closeTime: Number(r.close_time),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }));
    byS.set(symbol, rows);
  }
  return byS;
}

async function codeHashOfCore(rootDir: string): Promise<string> {
  const coreDir = resolve(rootDir, "packages/bot/src/core");
  const files = (await readdir(coreDir)).filter((f) => f.endsWith(".ts")).sort();
  const hasher = createHash("sha256");
  for (const f of files) {
    hasher.update(f);
    hasher.update("\x00");
    hasher.update(await readFile(resolve(coreDir, f)));
  }
  return `sha256:${hasher.digest("hex")}`;
}

interface ArbParams extends WinningParameters {
  readonly arb_volume_multiplier: number;
  readonly arb_min_range_pct: number;
  readonly arb_max_range_pct: number;
  readonly arb_stop_buffer_atr: number;
  readonly arb_tp1_r: number;
  readonly arb_tp2_r: number;
}

function buildParamSweep(sparse: boolean): ArbParams[] {
  const volMultipliers = sparse ? [1.3] : [1.2, 1.3, 1.4, 1.5];
  const minRanges = sparse ? [0.4] : [0.3, 0.4, 0.5];
  const maxRanges = sparse ? [2.5] : [2.0, 2.5, 3.0];
  const stopBuffers = sparse ? [0.5] : [0.3, 0.5, 0.7];
  const tp1s = sparse ? [1.5] : [1.0, 1.5, 2.0];
  const tp2s = sparse ? [3.0] : [2.5, 3.0, 3.5];
  const out: ArbParams[] = [];
  for (const v of volMultipliers)
    for (const mn of minRanges)
      for (const mx of maxRanges)
        for (const sb of stopBuffers)
          for (const t1 of tp1s)
            for (const t2 of tp2s)
              if (t2 > t1)
                out.push({
                  arb_volume_multiplier: v,
                  arb_min_range_pct: mn,
                  arb_max_range_pct: mx,
                  arb_stop_buffer_atr: sb,
                  arb_tp1_r: t1,
                  arb_tp2_r: t2,
                });
  return out;
}

/** Build an ARB StrategyEvaluator bound to params. Single-symbol per evaluator call. */
function buildArbEvaluator(params: ArbParams): StrategyEvaluator {
  return {
    name: "ARB",
    evaluate(symbol, candles, hasOpenPosition) {
      if (candles.length < 30) return null;
      const atrArr = computeAtr(candles, 14);
      const lastAtr = atrArr[atrArr.length - 1];
      if (lastAtr === undefined || !Number.isFinite(lastAtr)) return null;
      const input: ArbInputs = {
        symbol,
        candles,
        atr: lastAtr,
        hasExistingPosition: hasOpenPosition,
        opts: {
          volumeMultiplier: params.arb_volume_multiplier,
          minRangePct: params.arb_min_range_pct,
          maxRangePct: params.arb_max_range_pct,
          stopBufferAtr: params.arb_stop_buffer_atr,
          tp1Rmultiple: params.arb_tp1_r,
          tp2Rmultiple: params.arb_tp2_r,
        },
      };
      const r = evaluateArb(input);
      return r.type === "FIRE" ? r.signal : null;
    },
  };
}

function backtest(
  candles: readonly Candle[],
  params: ArbParams,
  startingEquity: number,
): StageBacktestResult {
  const strategy = buildArbEvaluator(params);
  const r = runReplay({
    candles,
    strategies: [strategy],
    opts: { startingEquity },
  });
  const equityCurve: readonly EquityPoint[] = r.equityCurve;
  const report = buildReport(r.trades as readonly Trade[], equityCurve, startingEquity);
  return {
    trades: r.trades,
    equityCurve,
    sharpe: report.summary.sharpe,
    maxDdPct: report.summary.maxDrawdownPct,
    totalReturnPct: report.summary.totalReturnPct,
    winRatePct: report.summary.winRatePct,
    profitFactor: report.summary.profitFactor,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const log = initLogger({
    level: env.LOG_LEVEL,
    format: env.LOG_FORMAT,
    nodeEnv: env.NODE_ENV,
  }).child({ cli: "run-validation" });

  const startMs = new Date(`${args.start}T00:00:00Z`).getTime();
  const endMs = new Date(`${args.end}T00:00:00Z`).getTime();
  const oosMs = args.oosMonths * 30 * DAY_MS;
  const oosStart = endMs - oosMs;

  log.info({ start: args.start, end: args.end, oosMonths: args.oosMonths }, "loading candles");
  const candlesBySymbol = await loadCandles(startMs, endMs);
  let totalRows = 0;
  for (const [s, rows] of candlesBySymbol) {
    log.info({ symbol: s, rows: rows.length }, "candle window loaded");
    totalRows += rows.length;
  }
  if (totalRows === 0) {
    log.error("no candles in DB for requested window — run `pnpm --filter bot backfill` first");
    await failArtifact(args.output, ["no candles in DB for requested window"], startMs, endMs);
    await closePool();
    process.exit(1);
  }

  // Use BTCUSDT training window for parameter sweep (per spec — full pipeline
  // would sweep all three symbols; single-symbol is acceptable for this phase
  // since the ARB strategy tests on BTC in the spec §2.4 worked example).
  const btc = candlesBySymbol.get("BTCUSDT") ?? [];
  const training = btc.filter((c) => c.openTime < oosStart);
  const oos = btc.filter((c) => c.openTime >= oosStart);
  log.info({ training: training.length, oos: oos.length }, "windows split");

  const startingEquity = 10_000;
  const rootDir = resolve(process.cwd(), "..", "..");
  const codeHash = await codeHashOfCore(rootDir).catch(() => "sha256:dev");
  const nowUtc = Date.now();
  const monthsCovered = Math.max(1, Math.round((endMs - startMs) / (30 * DAY_MS)));

  const sweep = buildParamSweep(args.sparse);
  log.info({ combos: sweep.length }, "param sweep built");

  const pipelineInputs: PipelineInputs<ArbParams> = {
    paramSweep: sweep,
    trainingCandles: training,
    oosCandles: oos,
    backtestFn: (cs, p) => backtest(cs, p, startingEquity),
    walkForwardOpts: {
      trainFn: (cs) => {
        // Cheap in-sample pick: scan a subset of the sweep, pick highest Sharpe.
        // For a real run we'd parallelize — keep this single-threaded for
        // readability.
        let best: { params: ArbParams; sharpe: number } | null = null;
        for (const p of sweep) {
          const r = backtest(cs, p, startingEquity);
          if (!best || r.sharpe > best.sharpe) best = { params: p, sharpe: r.sharpe };
        }
        if (!best) throw new Error("empty sweep in walk-forward trainFn");
        return { params: best.params, result: { sharpe: best.sharpe } };
      },
    },
    symbols: SYMBOLS,
    startingEquity,
    codeHash,
    nowUtc,
    dataWindow: {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      monthsCovered,
    },
    mcRuns: args.mcRuns,
  };

  const result = await runValidationPipeline(pipelineInputs);
  log.info(
    {
      haltedAt: result.diagnostics.haltedAt,
      winnerScore: result.artifact.compositeScore,
      deploymentAllowed: result.artifact.deploymentAllowed,
    },
    "pipeline complete",
  );

  await mkdir(resolve(args.output, ".."), { recursive: true });
  await writeFile(args.output, JSON.stringify(result.artifact, null, 2));
  log.info({ output: args.output }, "artifact written");

  // Capture validation snapshot per §8.12.1 alongside the artifact.
  const artifactHash = createHash("sha256")
    .update(JSON.stringify(result.artifact))
    .digest("hex");
  const snapshot = captureValidationSnapshot({
    artifactHash,
    candlesBySymbol,
    nowUtc,
  });
  const snapshotPath = resolve(args.output, "..", "validation_snapshot.json");
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2));
  log.info({ snapshotPath }, "validation snapshot written");

  if (!result.artifact.deploymentAllowed) {
    const md =
      `# Validation Failed\n\n` +
      `**Halted at:** ${result.diagnostics.haltedAt}\n\n` +
      `**Blockers:**\n${(result.artifact.deploymentBlockers ?? []).map((b) => `  - ${b}`).join("\n")}\n\n` +
      `**Pipeline counts:**\n` +
      `  - sweep: ${result.diagnostics.sweepCount}\n` +
      `  - after stage 1: ${result.diagnostics.afterStage1}\n` +
      `  - after stage 2 (MC): ${result.diagnostics.afterStage2}\n` +
      `  - after stage 3 (WF): ${result.diagnostics.afterStage3}\n` +
      `  - after stage 4 (OOS): ${result.diagnostics.afterStage4}\n`;
    await writeFile(resolve(process.cwd(), "VALIDATION_FAILED.md"), md);
    log.error("validation gate NOT passed — wrote VALIDATION_FAILED.md");
  }

  await closePool();
}

async function failArtifact(
  outputPath: string,
  blockers: readonly string[],
  startMs: number,
  endMs: number,
): Promise<void> {
  const artifact: ValidatedConfig = {
    artifactVersion: "1.0",
    createdAt: new Date().toISOString(),
    codeHash: "sha256:dev",
    dataWindow: {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      monthsCovered: 0,
    },
    symbols: SYMBOLS,
    winningParameters: {},
    validationResults: {
      backtest: { totalReturnPct: 0, sharpe: 0, maxDdPct: 0, tradeCount: 0, winRatePct: 0, profitFactor: 0 },
      monteCarlo: { runs: 0, medianReturnPct: 0, p5ReturnPct: 0, p95ReturnPct: 0, p95MaxDdPct: 0, probNegativeReturnPct: 0 },
      walkForward: { windowsTested: 0, avgTestSharpe: 0, trainToTestRatio: 0, paramStabilityMaxDeviationPct: 0 },
      outOfSample: { period: "", sharpe: 0, maxDdPct: 0, returnPct: 0 },
    },
    compositeScore: 0,
    deploymentAllowed: false,
    deploymentBlockers: blockers,
  };
  await mkdir(resolve(outputPath, ".."), { recursive: true });
  await writeFile(outputPath, JSON.stringify(artifact, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
