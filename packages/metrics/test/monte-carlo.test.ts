import { describe, expect, it } from "vitest";

import type { ClosedTrade } from "../src/equity-curve.js";
import { monteCarloShuffle } from "../src/monte-carlo.js";

function trade(pnl: number, idx: number): ClosedTrade {
  return {
    entryTime: new Date(2024, 0, idx + 1),
    exitTime: new Date(2024, 0, idx + 2),
    realizedPnLUsd: pnl,
    realizedRMultiple: pnl / 100,
    originatingStrategy: "test",
  };
}

describe("monteCarloShuffle", () => {
  it("returns 5/50/95 percentile bundle for each metric", () => {
    const trades = [trade(100, 0), trade(-50, 1), trade(150, 2), trade(-100, 3)];
    const out = monteCarloShuffle({
      initialEquityUsd: 1000,
      trades,
      shuffles: 1000,
      seed: 42,
    });
    expect(out.shuffles).toBe(1000);
    // Final equity is invariant under shuffle (sum of pnls is fixed).
    expect(out.finalEquity.p5).toBe(1100);
    expect(out.finalEquity.p50).toBe(1100);
    expect(out.finalEquity.p95).toBe(1100);
    // Drawdown bounded between worst-case and best-case orderings.
    expect(out.maxDrawdownUsd.p5).toBeLessThanOrEqual(out.maxDrawdownUsd.p95);
  });

  it("deterministic for same seed", () => {
    const trades = Array.from({ length: 10 }, (_, i) => trade(i % 2 === 0 ? 10 : -5, i));
    const a = monteCarloShuffle({
      initialEquityUsd: 1000,
      trades,
      shuffles: 500,
      seed: 7,
    });
    const b = monteCarloShuffle({
      initialEquityUsd: 1000,
      trades,
      shuffles: 500,
      seed: 7,
    });
    expect(a.finalEquity).toEqual(b.finalEquity);
    expect(a.maxDrawdownUsd).toEqual(b.maxDrawdownUsd);
    expect(a.longestLosingStreak).toEqual(b.longestLosingStreak);
  });
});
