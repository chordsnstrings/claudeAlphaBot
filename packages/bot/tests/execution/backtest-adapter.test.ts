import { describe, expect, it } from "vitest";

import type { Candle, SizedSignal } from "@hydra/shared";

import { BacktestAdapter } from "../../src/execution/backtest-adapter.js";

const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2024, 0, 1);

function baseSignal(overrides: Partial<SizedSignal> = {}): SizedSignal {
  return {
    strategy: "ARB",
    symbol: "BTCUSDT",
    direction: "LONG",
    generatedAt: T0,
    entryPrice: 100,
    stopPrice: 98,
    tp1Price: 103,
    tp2Price: 106,
    tp1AllocationPct: 50,
    breakevenTriggerPrice: 102,
    timeStopUtc: T0 + 12 * HOUR_MS,
    reasoning: "test",
    quantity: 1,
    notionalUsd: 100,
    riskUsd: 2,
    marginUsd: 10,
    leverage: 10,
    ...overrides,
  };
}

function candle(openTime: number, o: number, h: number, l: number, c: number): Candle {
  return {
    symbol: "BTCUSDT",
    openTime,
    closeTime: openTime + HOUR_MS - 1,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 1,
  };
}

describe("BacktestAdapter.submitEntry", () => {
  it("applies slippage + taker fee to intended price", async () => {
    const a = new BacktestAdapter();
    const r = await a.submitEntry(baseSignal(), T0);
    // 2 bps slippage on LONG: entryPrice = 100 * 1.0002 = 100.02
    expect(r.position.entryPrice).toBeCloseTo(100.02, 4);
    expect(r.position.mode).toBe("backtest");
    expect(r.position.tp1Filled).toBe(false);
    expect(r.feePaid).toBeCloseTo(100.02 * 0.0004, 6);
  });

  it("preserves SHORT with negative slippage", async () => {
    const a = new BacktestAdapter();
    const r = await a.submitEntry(baseSignal({ direction: "SHORT" }), T0);
    expect(r.position.entryPrice).toBeCloseTo(99.98, 4);
  });
});

describe("BacktestAdapter.checkExits", () => {
  it("TP1 emits partial with updatedPosition + breakeven stop", async () => {
    const a = new BacktestAdapter();
    const r = await a.submitEntry(baseSignal(), T0);
    // Candle reaches tp1Price=103, does not touch stop
    const events = await a.checkExits({
      position: r.position,
      candle: candle(T0 + HOUR_MS, 100, 103.5, 99, 103),
      accountEquityBefore: 10_000,
      nowUtc: T0 + HOUR_MS,
    });
    expect(events.length).toBe(1);
    const e = events[0]!;
    expect(e.fullyClosed).toBe(false);
    expect(e.exitReason).toBe("TP1");
    expect(e.closeQuantity).toBeCloseTo(0.5, 6);
    expect(e.updatedPosition!.tp1Filled).toBe(true);
    expect(e.updatedPosition!.stopPrice).toBe(r.position.entryPrice);
    expect(e.trade).toBeUndefined();
  });

  it("TP2 emits full close with Trade row", async () => {
    const a = new BacktestAdapter();
    const r = await a.submitEntry(baseSignal(), T0);
    const events = await a.checkExits({
      position: r.position,
      candle: candle(T0 + HOUR_MS, 100, 107, 99, 106),
      accountEquityBefore: 10_000,
      nowUtc: T0 + HOUR_MS,
    });
    expect(events.length).toBe(1);
    const e = events[0]!;
    expect(e.fullyClosed).toBe(true);
    expect(e.exitReason).toBe("TP2");
    expect(e.trade).toBeDefined();
    expect(e.trade!.pnlUsd).toBeGreaterThan(0);
  });

  it("STOP wins over TP when both touched in same candle", async () => {
    const a = new BacktestAdapter();
    const r = await a.submitEntry(baseSignal(), T0);
    const events = await a.checkExits({
      position: r.position,
      candle: candle(T0 + HOUR_MS, 100, 107, 97, 100),
      accountEquityBefore: 10_000,
      nowUtc: T0 + HOUR_MS,
    });
    expect(events[0]!.exitReason).toBe("STOP");
    expect(events[0]!.fullyClosed).toBe(true);
  });

  it("NO_FILL returns empty array", async () => {
    const a = new BacktestAdapter();
    const r = await a.submitEntry(baseSignal(), T0);
    const events = await a.checkExits({
      position: r.position,
      candle: candle(T0 + HOUR_MS, 100, 101, 99, 100),
      accountEquityBefore: 10_000,
      nowUtc: T0 + HOUR_MS,
    });
    expect(events).toEqual([]);
  });
});

describe("BacktestAdapter.closePosition", () => {
  it("produces a MANUAL trade at entry price", async () => {
    const a = new BacktestAdapter();
    const r = await a.submitEntry(baseSignal(), T0);
    const e = await a.closePosition(r.position, "MANUAL", T0 + HOUR_MS, 10_000);
    expect(e.exitReason).toBe("MANUAL");
    expect(e.fullyClosed).toBe(true);
    expect(e.trade).toBeDefined();
  });
});
