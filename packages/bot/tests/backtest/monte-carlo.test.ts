import { describe, expect, it } from "vitest";

import type { Trade } from "@hydra/shared";

import {
  DEFAULT_MC_CRITERIA,
  lcg,
  passesMonteCarloGate,
  runMonteCarlo,
} from "../../src/backtest/monte-carlo.js";

function trade(pnlUsd: number, pnlR = pnlUsd / 100): Trade {
  return {
    tradeId: 0,
    mode: "backtest",
    strategy: "ARB",
    symbol: "BTCUSDT",
    direction: "LONG",
    entryTime: 0,
    entryPrice: 100,
    quantity: 1,
    notionalUsd: 100,
    stopPrice: 99,
    tp1Price: 101,
    tp2Price: 102,
    exitTime: 0,
    exitPrice: 100 + pnlUsd,
    exitReason: "TP2",
    pnlUsd,
    pnlR,
    feesPaid: 0,
    accountEquityBefore: 10_000,
    accountEquityAfter: 10_000 + pnlUsd,
  };
}

describe("lcg", () => {
  it("is deterministic for a given seed", () => {
    const a = lcg(42);
    const b = lcg(42);
    for (let i = 0; i < 5; i++) expect(a()).toBe(b());
  });
});

describe("runMonteCarlo", () => {
  it("returns stats for a winning strategy", () => {
    const trades: Trade[] = [];
    // Varied trade sizes so permutations produce a spread of drawdowns
    for (let i = 0; i < 30; i++) trades.push(trade(i % 3 === 0 ? -200 : 150 + i * 5));
    const s = runMonteCarlo({
      trades,
      startingEquity: 10_000,
      opts: { runs: 200, seed: 1 },
    });
    expect(s.runs).toBe(200);
    expect(s.medianReturnPct).toBeGreaterThan(0);
    // Same trades in different orders → same total return, but DD spreads.
    expect(s.p95MaxDdPct).toBeGreaterThanOrEqual(s.medianMaxDdPct);
    expect(s.p5ReturnPct).toBeLessThanOrEqual(s.p95ReturnPct);
  });

  it("deterministic across runs with same seed", () => {
    const trades: Trade[] = [];
    for (let i = 0; i < 20; i++) trades.push(trade(i % 2 === 0 ? 100 : -50));
    const s1 = runMonteCarlo({ trades, startingEquity: 10_000, opts: { runs: 50, seed: 7 } });
    const s2 = runMonteCarlo({ trades, startingEquity: 10_000, opts: { runs: 50, seed: 7 } });
    expect(s1.medianReturnPct).toBe(s2.medianReturnPct);
    expect(s1.p95MaxDdPct).toBe(s2.p95MaxDdPct);
  });
});

describe("passesMonteCarloGate", () => {
  it("fails when prob_negative too high", () => {
    const s = {
      runs: 100,
      medianReturnPct: 2,
      p5ReturnPct: -5,
      p95ReturnPct: 10,
      medianMaxDdPct: 10,
      p95MaxDdPct: 20,
      probNegativeReturnPct: 25,
    };
    const g = passesMonteCarloGate(s);
    expect(g.pass).toBe(false);
    expect(g.failures.some((f) => f.includes("prob_negative_return"))).toBe(true);
  });

  it("passes when all thresholds met", () => {
    const s = {
      runs: 100,
      medianReturnPct: 20,
      p5ReturnPct: 5,
      p95ReturnPct: 40,
      medianMaxDdPct: 10,
      p95MaxDdPct: 20,
      probNegativeReturnPct: 3,
    };
    const g = passesMonteCarloGate(s);
    expect(g.pass).toBe(true);
  });

  it("uses default criteria when none supplied", () => {
    expect(DEFAULT_MC_CRITERIA.maxProbNegativePct).toBe(10);
  });
});
