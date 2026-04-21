import { describe, expect, it } from "vitest";

import { findSuspiciousResults } from "../../src/backtest/sanity.js";
import type { SummaryMetrics } from "../../src/backtest/metrics.js";

function summary(over: Partial<SummaryMetrics>): SummaryMetrics {
  return {
    startingEquity: 5_000,
    finalEquity: 5_000,
    totalReturnPct: 0,
    annualizedReturnPct: 0,
    trades: 25,
    winRatePct: 55,
    profitFactor: 1.5,
    avgWinR: 1.5,
    avgLossR: -1,
    expectancyR: 0.3,
    maxDrawdownPct: 10,
    maxDrawdownDurationDays: 5,
    sharpe: 1.4,
    sortino: 2,
    calmar: 4,
    totalFeesUsd: 200,
    feesAsPctOfGrossPnl: 5,
    ...over,
  };
}

describe("findSuspiciousResults", () => {
  it("clean run produces no findings", () => {
    expect(findSuspiciousResults(summary({}))).toEqual([]);
  });
  it("flags RETURN_TOO_HIGH when return > 100%", () => {
    const f = findSuspiciousResults(summary({ totalReturnPct: 250 }));
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe("RETURN_TOO_HIGH");
  });
  it("flags DRAWDOWN_TOO_LOW when DD < 5% and trades ≥ 20", () => {
    const f = findSuspiciousResults(summary({ maxDrawdownPct: 2 }));
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe("DRAWDOWN_TOO_LOW");
  });
  it("does NOT flag low DD when trade count is too small to be meaningful", () => {
    const f = findSuspiciousResults(summary({ maxDrawdownPct: 2, trades: 5 }));
    expect(f).toEqual([]);
  });
  it("flags both findings when both breached", () => {
    const f = findSuspiciousResults(summary({ totalReturnPct: 500, maxDrawdownPct: 0.5 }));
    expect(f.map((x) => x.kind).sort()).toEqual(["DRAWDOWN_TOO_LOW", "RETURN_TOO_HIGH"]);
  });
  it("respects custom thresholds", () => {
    const f = findSuspiciousResults(
      summary({ totalReturnPct: 80, maxDrawdownPct: 7 }),
      { returnPctThreshold: 50, maxDrawdownPctThreshold: 10 },
    );
    expect(f.map((x) => x.kind).sort()).toEqual(["DRAWDOWN_TOO_LOW", "RETURN_TOO_HIGH"]);
  });
});
