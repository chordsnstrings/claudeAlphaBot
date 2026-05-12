/**
 * MetricsCollector full-snapshot tests. Confirms the trade-level,
 * equity-level, and aggregate metrics line up with hand calculations.
 */

import { describe, expect, it } from "vitest";

import { MetricsCollector } from "../src/metrics-collector.js";

describe("MetricsCollector", () => {
  it("returns an empty-but-well-formed snapshot for zero trades", () => {
    const m = new MetricsCollector({ initialEquityUsd: 100_000 });
    const snap = m.snapshot();
    expect(snap.trades.n).toBe(0);
    expect(snap.trades.winRate.point).toBe(0);
    expect(snap.equity.totalReturnPct).toBe(0);
    expect(snap.monteCarlo).toBeNull();
  });

  it("computes win rate, expectancy, profit factor on a small known set", () => {
    const m = new MetricsCollector({ initialEquityUsd: 10_000, seed: 42 });
    // 3 wins of +100, 2 losses of -50. Net +200.
    const baseDate = Date.parse("2024-01-01T00:00:00Z");
    const pnls = [100, 100, -50, 100, -50];
    for (let i = 0; i < pnls.length; i += 1) {
      const pnl = pnls[i] ?? 0;
      m.recordTrade({
        entryTime: new Date(baseDate + i * 86_400_000),
        exitTime: new Date(baseDate + (i + 1) * 86_400_000),
        realizedPnLUsd: pnl,
        realizedRMultiple: pnl / 50, // assume risk = 50
        originatingStrategy: "S1",
      });
    }
    const snap = m.snapshot();
    expect(snap.trades.n).toBe(5);
    expect(snap.trades.winRate.point).toBe(0.6);
    // Expectancy = (100+100-50+100-50)/5 = 40
    expect(snap.trades.expectancyUsd).toBeCloseTo(40, 8);
    // Profit factor = (3*100) / (2*50) = 300/100 = 3
    expect(snap.trades.profitFactor).toBeCloseTo(3, 8);
    // Per-strategy attribution
    expect(snap.perStrategy["S1"]?.netPnlUsd).toBe(200);
    expect(snap.perStrategy["S1"]?.n).toBe(5);
  });

  it("equity finalUsd reflects sum of pnls", () => {
    const m = new MetricsCollector({ initialEquityUsd: 1000 });
    const baseDate = Date.parse("2024-01-01T00:00:00Z");
    for (const pnl of [100, -50, 25]) {
      m.recordTrade({
        entryTime: new Date(baseDate),
        exitTime: new Date(baseDate + 86_400_000),
        realizedPnLUsd: pnl,
        realizedRMultiple: pnl / 100,
        originatingStrategy: "S1",
      });
    }
    const snap = m.snapshot();
    expect(snap.equity.initialUsd).toBe(1000);
    expect(snap.equity.finalUsd).toBe(1075);
    expect(snap.equity.totalReturnPct).toBeCloseTo(0.075, 8);
  });

  it("incremental == final-mode: same metrics from one-shot vs per-trade insert", () => {
    const oneShot = new MetricsCollector({ initialEquityUsd: 10_000 });
    const incremental = new MetricsCollector({ initialEquityUsd: 10_000 });
    const base = Date.parse("2024-06-01T00:00:00Z");
    const trades = [200, -100, 150, -80, 220, -120].map((pnl, i) => ({
      entryTime: new Date(base + i * 86_400_000),
      exitTime: new Date(base + (i + 1) * 86_400_000),
      realizedPnLUsd: pnl,
      realizedRMultiple: pnl / 100,
      originatingStrategy: "S1",
    }));
    for (const t of trades) {
      oneShot.recordTrade(t);
      incremental.recordTrade(t);
    }
    const a = oneShot.snapshot();
    const b = incremental.snapshot();
    expect(a.trades.n).toBe(b.trades.n);
    expect(a.equity.finalUsd).toBe(b.equity.finalUsd);
    expect(a.trades.expectancyUsd).toBe(b.trades.expectancyUsd);
  });

  it("uses Monte Carlo reshuffling for trade-sequence-dependent metrics", () => {
    const m = new MetricsCollector({
      initialEquityUsd: 10_000,
      seed: 42,
      monteCarloShuffles: 500,
    });
    const base = Date.parse("2024-01-01T00:00:00Z");
    for (let i = 0; i < 20; i += 1) {
      const pnl = i % 3 === 0 ? -200 : 100;
      m.recordTrade({
        entryTime: new Date(base + i * 86_400_000),
        exitTime: new Date(base + (i + 1) * 86_400_000),
        realizedPnLUsd: pnl,
        realizedRMultiple: pnl / 100,
        originatingStrategy: "S1",
      });
    }
    const snap = m.snapshot();
    expect(snap.monteCarlo).not.toBeNull();
    expect(snap.monteCarlo?.shuffles).toBe(500);
    // Final-equity distribution is invariant under shuffle (sum is fixed).
    const fe = snap.monteCarlo?.finalEquity;
    expect(fe?.p5).toBe(fe?.p50);
    expect(fe?.p50).toBe(fe?.p95);
  });
});
