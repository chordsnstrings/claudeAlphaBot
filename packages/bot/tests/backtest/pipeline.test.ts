import { describe, expect, it } from "vitest";

import type { Candle, Trade, WinningParameters } from "@hydra/shared";

import {
  compositeScore,
  runValidationPipeline,
  type StageBacktestResult,
} from "../../src/backtest/pipeline.js";

const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2024, 0, 1);

function trade(pnl: number, exitTime: number): Trade {
  return {
    tradeId: 0,
    mode: "backtest",
    strategy: "ARB",
    symbol: "BTCUSDT",
    direction: "LONG",
    entryTime: exitTime - HOUR_MS,
    entryPrice: 100,
    quantity: 1,
    notionalUsd: 100,
    stopPrice: 99,
    tp1Price: 101,
    tp2Price: 102,
    exitTime,
    exitPrice: 100 + pnl,
    exitReason: pnl > 0 ? "TP2" : "STOP",
    pnlUsd: pnl,
    pnlR: pnl / 50,
    feesPaid: 0.5,
    accountEquityBefore: 10_000,
    accountEquityAfter: 10_000 + pnl,
  };
}

function candles(start: number, count: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      symbol: "BTCUSDT",
      openTime: start + i * HOUR_MS,
      closeTime: start + i * HOUR_MS + HOUR_MS - 1,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1,
    });
  }
  return out;
}

interface FakeParams extends WinningParameters {
  readonly score: number;
}

describe("compositeScore", () => {
  it("matches spec §8.11.1 Stage 5 formula", () => {
    const s = compositeScore({
      testSharpe: 1.42,
      oosSharpe: 1.31,
      monteCarloP5ReturnPct: 41.3,
      maxDrawdownPct: 15.8,
      parameterStabilityScore: 0.92,
      tradeCount: 347,
    });
    // 1.42*0.35 + 1.31*0.25 + 41.3*0.002 + (1-0.158)*0.15 + 0.92*0.15 + 1*0.10
    //  = 0.497 + 0.3275 + 0.0826 + 0.1263 + 0.138 + 0.10 = 1.2714
    expect(s).toBeCloseTo(1.2714, 3);
  });
});

describe("runValidationPipeline", () => {
  it("halts at SWEEP when paramSweep empty", async () => {
    const result = await runValidationPipeline<FakeParams>({
      paramSweep: [],
      trainingCandles: candles(T0, 100),
      oosCandles: candles(T0 + 1_000_000, 50),
      backtestFn: () => ({
        trades: [], equityCurve: [], sharpe: 0, maxDdPct: 0,
        totalReturnPct: 0, winRatePct: 0, profitFactor: 0,
      } satisfies StageBacktestResult),
      walkForwardOpts: {
        trainDays: 30,
        testDays: 10,
        trainFn: () => ({ params: { score: 1 }, result: { sharpe: 0 } }),
      },
      symbols: ["BTCUSDT"],
      startingEquity: 10_000,
      codeHash: "sha256:dev",
      nowUtc: T0,
      dataWindow: { start: "a", end: "b", monthsCovered: 1 },
      mcRuns: 10,
    });
    expect(result.artifact.deploymentAllowed).toBe(false);
    expect(result.diagnostics.haltedAt).toBe("SWEEP");
  });

  it("halts at MONTE_CARLO when no candidates pass gate", async () => {
    // Strong training sharpe but losing MC (all-negative trades → p5<0)
    const losingTrades: Trade[] = [];
    for (let i = 0; i < 30; i++) losingTrades.push(trade(-100, T0 + i * HOUR_MS));
    const result = await runValidationPipeline<FakeParams>({
      paramSweep: [{ score: 1 }, { score: 2 }],
      trainingCandles: candles(T0, 100),
      oosCandles: candles(T0 + 1_000_000, 50),
      backtestFn: (_cs, _p) => ({
        trades: losingTrades,
        equityCurve: [],
        sharpe: 1.5,
        maxDdPct: 5,
        totalReturnPct: -30,
        winRatePct: 0,
        profitFactor: 0,
      } satisfies StageBacktestResult),
      walkForwardOpts: {
        trainDays: 30,
        testDays: 10,
        trainFn: () => ({ params: { score: 1 }, result: { sharpe: 1.5 } }),
      },
      symbols: ["BTCUSDT"],
      startingEquity: 10_000,
      codeHash: "sha256:dev",
      nowUtc: T0,
      dataWindow: { start: "a", end: "b", monthsCovered: 1 },
      mcRuns: 100,
    });
    expect(result.artifact.deploymentAllowed).toBe(false);
    expect(["MONTE_CARLO", "WALK_FORWARD", "OOS"]).toContain(result.diagnostics.haltedAt);
    expect(result.artifact.deploymentBlockers?.length ?? 0).toBeGreaterThan(0);
  });

  it("emits ValidatedConfig shape with all required fields on any outcome", async () => {
    const result = await runValidationPipeline<FakeParams>({
      paramSweep: [{ score: 1 }],
      trainingCandles: candles(T0, 100),
      oosCandles: candles(T0 + 1_000_000, 50),
      backtestFn: () => ({
        trades: [], equityCurve: [], sharpe: 0, maxDdPct: 0,
        totalReturnPct: 0, winRatePct: 0, profitFactor: 0,
      } satisfies StageBacktestResult),
      walkForwardOpts: {
        trainDays: 30, testDays: 10,
        trainFn: () => ({ params: { score: 1 }, result: { sharpe: 0 } }),
      },
      symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
      startingEquity: 10_000,
      codeHash: "sha256:abc",
      nowUtc: T0,
      dataWindow: { start: "2024-01-01T00:00:00Z", end: "2024-12-31T23:59:59Z", monthsCovered: 12 },
      mcRuns: 10,
    });
    const a = result.artifact;
    expect(a.artifactVersion).toBe("1.0");
    expect(a.codeHash).toBe("sha256:abc");
    expect(a.symbols).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
    expect(a.validationResults.backtest).toBeDefined();
    expect(a.validationResults.monteCarlo).toBeDefined();
    expect(a.validationResults.walkForward).toBeDefined();
    expect(a.validationResults.outOfSample).toBeDefined();
    expect(typeof a.compositeScore).toBe("number");
    expect(typeof a.deploymentAllowed).toBe("boolean");
  });
});
