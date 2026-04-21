import { describe, expect, it } from "vitest";

import type { Candle } from "@hydra/shared";

import {
  generateWalkForwardWindows,
  paramStability,
  passesWalkForwardGate,
  runWalkForward,
} from "../../src/backtest/walk-forward.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

function bars(startMs: number, count: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      symbol: "BTCUSDT",
      openTime: startMs + i * HOUR_MS,
      closeTime: startMs + i * HOUR_MS + HOUR_MS - 1,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1,
    });
  }
  return out;
}

describe("generateWalkForwardWindows", () => {
  it("produces non-overlapping test windows", () => {
    const wins = Array.from(
      generateWalkForwardWindows(T0, T0 + 400 * DAY_MS, 180, 60),
    );
    expect(wins.length).toBeGreaterThan(0);
    for (const w of wins) {
      expect(w.trainEnd - w.trainStart).toBe(180 * DAY_MS);
      expect(w.testEnd - w.testStart).toBe(60 * DAY_MS);
    }
    // stride = testDays; verify second window starts testDays after first
    if (wins.length >= 2) {
      expect(wins[1]!.trainStart - wins[0]!.trainStart).toBe(60 * DAY_MS);
    }
  });

  it("returns 0 windows when data shorter than train+test", () => {
    const wins = Array.from(generateWalkForwardWindows(T0, T0 + 100 * DAY_MS, 180, 60));
    expect(wins.length).toBe(0);
  });
});

describe("runWalkForward", () => {
  it("iterates windows and aggregates Sharpe", () => {
    const candles = bars(T0, 24 * 400);
    const summary = runWalkForward(candles, {
      trainDays: 180,
      testDays: 60,
      trainFn: (_cs) => ({ params: { x: 10 }, result: { sharpe: 1.5 } }),
      backtestFn: (_cs, _p) => ({ sharpe: 1.0, maxDdPct: 10, trades: 50 }),
    });
    expect(summary.windows.length).toBeGreaterThan(0);
    expect(summary.avgTestSharpe).toBeCloseTo(1.0, 5);
    expect(summary.avgTrainSharpe).toBeCloseTo(1.5, 5);
    expect(summary.trainToTestRatio).toBeCloseTo(1.0 / 1.5, 5);
  });

  it("returns empty summary on empty candles", () => {
    const s = runWalkForward([], {
      trainDays: 10,
      testDays: 2,
      trainFn: () => ({ params: {}, result: { sharpe: 0 } }),
      backtestFn: () => ({ sharpe: 0, maxDdPct: 0, trades: 0 }),
    });
    expect(s.windows.length).toBe(0);
  });
});

describe("paramStability", () => {
  it("returns 0 for single set", () => {
    expect(paramStability([{ a: 1 }])).toBe(0);
  });

  it("reports max deviation across numeric keys", () => {
    const dev = paramStability([{ a: 100 }, { a: 110 }, { a: 90 }]);
    // mean=100, max deviation = 10 → 10%
    expect(dev).toBeCloseTo(10, 5);
  });

  it("ignores non-numeric fields", () => {
    const dev = paramStability([
      { a: 100, tag: "x" },
      { a: 105, tag: "y" },
    ]);
    // mean=102.5, max |x-mean|/mean × 100 = 2.5/102.5 ≈ 2.439%
    expect(dev).toBeCloseTo(2.44, 2);
  });
});

describe("passesWalkForwardGate", () => {
  it("fails when avg_test_sharpe too low", () => {
    const s = {
      windows: [
        {
          trainStart: 0,
          trainEnd: 1,
          testStart: 1,
          testEnd: 2,
          params: {},
          trainSharpe: 1,
          testSharpe: 0.5,
          testMaxDdPct: 10,
          testTrades: 50,
        },
      ],
      avgTestSharpe: 0.5,
      avgTrainSharpe: 1,
      trainToTestRatio: 0.5,
      paramStabilityMaxDeviationPct: 5,
    };
    const g = passesWalkForwardGate(s);
    expect(g.pass).toBe(false);
    expect(g.failures.some((f) => f.includes("avg_test_sharpe"))).toBe(true);
  });

  it("passes with strong stable results", () => {
    const s = {
      windows: [
        {
          trainStart: 0,
          trainEnd: 1,
          testStart: 1,
          testEnd: 2,
          params: {},
          trainSharpe: 1.5,
          testSharpe: 1.3,
          testMaxDdPct: 10,
          testTrades: 50,
        },
      ],
      avgTestSharpe: 1.3,
      avgTrainSharpe: 1.5,
      trainToTestRatio: 0.86,
      paramStabilityMaxDeviationPct: 5,
    };
    const g = passesWalkForwardGate(s);
    expect(g.pass).toBe(true);
  });
});
