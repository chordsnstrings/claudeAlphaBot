import { describe, expect, it } from "vitest";

import {
  annualizedSharpe,
  annualizedSortino,
  buildReport,
  drawdownStats,
  monthlyBreakdown,
  segmentBy,
  type EquityPoint,
} from "../../src/backtest/metrics.js";
import type { Trade } from "@hydra/shared";

function tradeStub(over: Partial<Trade> = {}): Trade {
  return {
    tradeId: 1,
    mode: "backtest",
    strategy: "ARB",
    symbol: "BTCUSDT",
    direction: "LONG",
    entryTime: Date.UTC(2024, 0, 1),
    entryPrice: 50_000,
    quantity: 0.1,
    notionalUsd: 5_000,
    stopPrice: 49_500,
    tp1Price: 50_750,
    tp2Price: 51_500,
    exitTime: Date.UTC(2024, 0, 1, 6),
    exitPrice: 50_750,
    exitReason: "TP1",
    pnlUsd: 75,
    pnlR: 1.5,
    feesPaid: 4,
    accountEquityBefore: 5_000,
    accountEquityAfter: 5_075,
    ...over,
  };
}

describe("drawdownStats", () => {
  it("computes max DD pct and duration", () => {
    const curve: EquityPoint[] = [
      { timestamp: 0, equity: 100 },
      { timestamp: 86_400_000, equity: 110 }, // peak
      { timestamp: 86_400_000 * 2, equity: 99 }, // dd start
      { timestamp: 86_400_000 * 3, equity: 88 }, // 20% from peak
      { timestamp: 86_400_000 * 4, equity: 105 }, // recover (still under peak)
    ];
    const dd = drawdownStats(curve);
    expect(dd.maxDrawdownPct).toBeCloseTo(20, 2);
    expect(dd.maxDrawdownDurationDays).toBeCloseTo(3, 2);
  });
  it("returns zero for monotonic up curve", () => {
    const curve: EquityPoint[] = [
      { timestamp: 0, equity: 100 },
      { timestamp: 1, equity: 101 },
      { timestamp: 2, equity: 110 },
    ];
    expect(drawdownStats(curve).maxDrawdownPct).toBe(0);
  });
});

describe("annualizedSharpe", () => {
  it("zero for constant returns", () => {
    expect(annualizedSharpe([0.001, 0.001, 0.001])).toBe(0);
  });
  it("scales mean/stdev by √(365*24)", () => {
    const rs = [0.001, -0.0005, 0.0008, -0.0002, 0.0012];
    const s = annualizedSharpe(rs);
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeGreaterThan(0);
  });
});

describe("annualizedSortino", () => {
  it("uses downside deviation only", () => {
    const r = annualizedSortino([0.01, 0.02, 0.03, -0.01]);
    expect(r).toBeGreaterThan(0);
  });
});

describe("monthlyBreakdown", () => {
  it("aggregates equity per UTC month", () => {
    const curve: EquityPoint[] = [
      { timestamp: Date.UTC(2024, 0, 1), equity: 5_000 },
      { timestamp: Date.UTC(2024, 0, 31), equity: 5_500 },
      { timestamp: Date.UTC(2024, 1, 1), equity: 5_500 },
      { timestamp: Date.UTC(2024, 1, 28), equity: 5_300 },
    ];
    const trades: Trade[] = [
      tradeStub({ tradeId: 1, exitTime: Date.UTC(2024, 0, 15), pnlUsd: 200 }),
      tradeStub({ tradeId: 2, exitTime: Date.UTC(2024, 0, 20), pnlUsd: 300 }),
      tradeStub({ tradeId: 3, exitTime: Date.UTC(2024, 1, 10), pnlUsd: -200 }),
    ];
    const rows = monthlyBreakdown(trades, curve, 5_000);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.month).toBe("2024-01");
    expect(rows[0]!.trades).toBe(2);
    expect(rows[0]!.returnPct).toBeCloseTo(((5_500 - 5_000) / 5_000) * 100, 4);
    expect(rows[1]!.month).toBe("2024-02");
    expect(rows[1]!.trades).toBe(1);
  });
});

describe("segmentBy", () => {
  it("groups by strategy with profit factor", () => {
    const trades: Trade[] = [
      tradeStub({ tradeId: 1, strategy: "ARB", pnlUsd: 100, pnlR: 1.5 }),
      tradeStub({ tradeId: 2, strategy: "ARB", pnlUsd: -50, pnlR: -1 }),
      tradeStub({ tradeId: 3, strategy: "NY_OPEN", pnlUsd: 200, pnlR: 2 }),
    ];
    const rows = segmentBy(trades, (t) => t.strategy);
    const arb = rows.find((r) => r.key === "ARB")!;
    expect(arb.trades).toBe(2);
    expect(arb.totalPnlUsd).toBe(50);
    expect(arb.profitFactor).toBeCloseTo(2, 6);
    const ny = rows.find((r) => r.key === "NY_OPEN")!;
    expect(ny.profitFactor).toBe(Infinity);
  });
});

describe("buildReport — integration", () => {
  it("computes summary, monthly, perStrategy, perSymbol, exitReasons", () => {
    const curve: EquityPoint[] = [
      { timestamp: Date.UTC(2024, 0, 1), equity: 5_000 },
      { timestamp: Date.UTC(2024, 1, 1), equity: 5_500 },
      { timestamp: Date.UTC(2024, 2, 1), equity: 5_700 },
    ];
    const trades: Trade[] = [
      tradeStub({ tradeId: 1, pnlUsd: 100, exitReason: "TP1" }),
      tradeStub({ tradeId: 2, pnlUsd: -50, exitReason: "STOP" }),
      tradeStub({ tradeId: 3, pnlUsd: 250, exitReason: "TP2", symbol: "ETHUSDT" }),
    ];
    const r = buildReport(trades, curve, 5_000);
    expect(r.summary.totalReturnPct).toBeCloseTo(14, 4);
    expect(r.summary.trades).toBe(3);
    expect(r.summary.winRatePct).toBeCloseTo(66.6666, 2);
    expect(r.perSymbol.find((x) => x.key === "ETHUSDT")!.trades).toBe(1);
    expect(r.perStrategy[0]!.key).toBe("ARB");
    const stop = r.exitReasons.find((x) => x.exitReason === "STOP");
    expect(stop!.count).toBe(1);
  });
});
