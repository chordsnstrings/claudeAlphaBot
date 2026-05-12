import { describe, expect, it } from "vitest";

import {
  cagr,
  dailyReturns,
  equityCurve,
  maxDrawdown,
  totalReturnPct,
  type ClosedTrade,
} from "../src/equity-curve.js";

function trade(
  exitIso: string,
  pnl: number,
  rMultiple = pnl / 100,
): ClosedTrade {
  return {
    entryTime: new Date(`${exitIso}T00:00:00Z`),
    exitTime: new Date(`${exitIso}T12:00:00Z`),
    realizedPnLUsd: pnl,
    realizedRMultiple: rMultiple,
    originatingStrategy: "test",
  };
}

describe("equityCurve / maxDrawdown / returns", () => {
  it("equity curve starts at initial equity and applies pnls in order", () => {
    const trades = [trade("2024-01-02", 100), trade("2024-01-03", -50), trade("2024-01-04", 25)];
    const c = equityCurve(1000, trades);
    expect(c[0]?.equityUsd).toBe(1000);
    expect(c[1]?.equityUsd).toBe(1100);
    expect(c[2]?.equityUsd).toBe(1050);
    expect(c[3]?.equityUsd).toBe(1075);
  });

  it("totalReturnPct from initial to final", () => {
    const c = equityCurve(1000, [trade("2024-01-02", 100), trade("2024-01-03", 50)]);
    expect(totalReturnPct(c)).toBeCloseTo(0.15, 8);
  });

  it("maxDrawdown picks the deepest peak-to-trough", () => {
    // 1000 -> 1100 -> 900 -> 1200 -> 800 -> 1300
    const trades = [
      trade("2024-01-02", 100),
      trade("2024-01-03", -200),
      trade("2024-01-04", 300),
      trade("2024-01-05", -400),
      trade("2024-01-06", 500),
    ];
    const c = equityCurve(1000, trades);
    const dd = maxDrawdown(c);
    // Deepest peak-to-trough: 1200 -> 800 = -400 USD = -33.3%
    expect(dd.maxDdUsd).toBe(-400);
    expect(dd.maxDdPct).toBeCloseTo(-400 / 1200, 8);
  });

  it("dailyReturns picks the last equity per UTC day", () => {
    // Trade entry on day 1, exit on day 2, then exit on day 3 -> 3 days
    // -> 2 returns.
    const t1: ClosedTrade = {
      entryTime: new Date("2024-01-01T00:00:00Z"),
      exitTime: new Date("2024-01-02T12:00:00Z"),
      realizedPnLUsd: 100,
      realizedRMultiple: 1,
      originatingStrategy: "test",
    };
    const t2: ClosedTrade = {
      entryTime: new Date("2024-01-02T12:01:00Z"),
      exitTime: new Date("2024-01-03T12:00:00Z"),
      realizedPnLUsd: -50,
      realizedRMultiple: -0.5,
      originatingStrategy: "test",
    };
    const c = equityCurve(1000, [t1, t2]);
    const ret = dailyReturns(c);
    expect(ret).toHaveLength(2);
    expect(ret[0]).toBeCloseTo(0.1, 8);
    expect(ret[1]).toBeCloseTo(-50 / 1100, 8);
  });

  it("cagr over a year of 10% growth is ~10%", () => {
    const points = [
      { at: new Date("2024-01-01T00:00:00Z"), equityUsd: 1000 },
      { at: new Date("2025-01-01T00:00:00Z"), equityUsd: 1100 },
    ];
    expect(cagr(points)).toBeCloseTo(0.1, 3);
  });
});
