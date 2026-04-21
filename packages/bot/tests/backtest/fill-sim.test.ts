import { describe, expect, it } from "vitest";

import {
  DEFAULT_SLIPPAGE_BPS,
  DEFAULT_TAKER_FEE,
  fundingPayment,
  simulateEntryFill,
  simulateExitForCandle,
  type ExitPositionInput,
} from "../../src/backtest/fill-sim.js";
import type { Candle } from "@hydra/shared";

const T = Date.UTC(2024, 9, 15, 7, 0, 0);

function bar(over: Partial<Candle> = {}): Candle {
  return {
    symbol: "BTCUSDT",
    openTime: T,
    closeTime: T + 3_600_000,
    open: 50_000,
    high: 50_500,
    low: 49_500,
    close: 50_200,
    volume: 100,
    ...over,
  };
}

const longPos = (over: Partial<ExitPositionInput> = {}): ExitPositionInput => ({
  direction: "LONG",
  entryPrice: 50_000,
  stopPrice: 49_500,
  tp1Price: 50_750,
  tp2Price: 51_500,
  remainingQuantity: 0.1,
  tp1Filled: false,
  timeStopUtc: T + 12 * 3_600_000,
  ...over,
});

describe("simulateEntryFill", () => {
  it("LONG: bumps price up by slippage and deducts taker fee on notional", () => {
    const r = simulateEntryFill(50_000, 0.1, "LONG");
    expect(r.entryPrice).toBeCloseTo(50_000 * (1 + DEFAULT_SLIPPAGE_BPS), 6);
    expect(r.feePaid).toBeCloseTo(r.entryPrice * 0.1 * DEFAULT_TAKER_FEE, 6);
  });
  it("SHORT: bumps price down by slippage", () => {
    const r = simulateEntryFill(50_000, 0.1, "SHORT");
    expect(r.entryPrice).toBeCloseTo(50_000 * (1 - DEFAULT_SLIPPAGE_BPS), 6);
  });
  it("respects custom slippage and fee", () => {
    const r = simulateEntryFill(100, 1, "LONG", { slippage: 0.001, takerFee: 0.0005 });
    expect(r.entryPrice).toBeCloseTo(100.1, 6);
    expect(r.feePaid).toBeCloseTo(100.1 * 1 * 0.0005, 6);
  });
});

describe("simulateExitForCandle — STOP wins on collisions (§8.4)", () => {
  it("LONG: stop AND TP1 hit → STOP fills (worst-case)", () => {
    const pos = longPos();
    const c = bar({ low: 49_400, high: 51_000 }); // low < stop, high > tp1
    const r = simulateExitForCandle(pos, c);
    expect(r.kind).toBe("EXIT");
    if (r.kind !== "EXIT") return;
    expect(r.exitReason).toBe("STOP");
    expect(r.exitPrice).toBeCloseTo(49_500 * (1 - DEFAULT_SLIPPAGE_BPS), 6);
    expect(r.fullyClosed).toBe(true);
  });

  it("SHORT: stop AND TP2 hit → STOP fills", () => {
    const pos = longPos({ direction: "SHORT", stopPrice: 50_500, tp1Price: 49_750, tp2Price: 49_000 });
    const c = bar({ low: 48_500, high: 50_600 });
    const r = simulateExitForCandle(pos, c);
    if (r.kind !== "EXIT") throw new Error("expected EXIT");
    expect(r.exitReason).toBe("STOP");
  });

  it("returns NO_FILL when candle stays inside the bracket", () => {
    const pos = longPos();
    const c = bar({ low: 49_900, high: 50_400 });
    const r = simulateExitForCandle(pos, c);
    expect(r.kind).toBe("NO_FILL");
  });
});

describe("simulateExitForCandle — TP1 partial close", () => {
  it("LONG: TP1 hit → 50% close, fullyClosed=false", () => {
    const pos = longPos();
    const c = bar({ low: 49_900, high: 51_000 }); // tp1 hit, tp2 not, no stop
    const r = simulateExitForCandle(pos, c);
    if (r.kind !== "EXIT") throw new Error("expected EXIT");
    expect(r.exitReason).toBe("TP1");
    expect(r.closeQuantity).toBeCloseTo(0.05, 8);
    expect(r.fullyClosed).toBe(false);
    expect(r.exitPrice).toBeCloseTo(50_750 * (1 - DEFAULT_SLIPPAGE_BPS), 6);
  });

  it("does NOT re-fill TP1 when tp1Filled is true", () => {
    const pos = longPos({ tp1Filled: true });
    const c = bar({ low: 49_900, high: 51_000 }); // tp1 touched but already filled
    const r = simulateExitForCandle(pos, c);
    expect(r.kind).toBe("NO_FILL");
  });

  it("TP2 hit fully closes, regardless of tp1Filled", () => {
    const pos = longPos({ tp1Filled: false });
    const c = bar({ low: 49_900, high: 51_600 });
    const r = simulateExitForCandle(pos, c);
    if (r.kind !== "EXIT") throw new Error("expected EXIT");
    expect(r.exitReason).toBe("TP2");
    expect(r.fullyClosed).toBe(true);
  });
});

describe("simulateExitForCandle — TIME_STOP", () => {
  it("fires when candle.openTime ≥ timeStopUtc, exits at close × (1−slip) for LONG", () => {
    const pos = longPos({ timeStopUtc: T });
    const c = bar({ low: 49_900, high: 50_300, close: 50_100 });
    const r = simulateExitForCandle(pos, c);
    if (r.kind !== "EXIT") throw new Error("expected EXIT");
    expect(r.exitReason).toBe("TIME_STOP");
    expect(r.exitPrice).toBeCloseTo(50_100 * (1 - DEFAULT_SLIPPAGE_BPS), 6);
  });

  it("STOP still wins over TIME_STOP if both apply", () => {
    const pos = longPos({ timeStopUtc: T });
    const c = bar({ low: 49_400 });
    const r = simulateExitForCandle(pos, c);
    if (r.kind !== "EXIT") throw new Error("expected EXIT");
    expect(r.exitReason).toBe("STOP");
  });
});

describe("fundingPayment", () => {
  it("LONG pays positive funding (positive return)", () => {
    expect(fundingPayment({ direction: "LONG", notionalUsd: 10_000, fundingRate: 0.0001 }))
      .toBeCloseTo(1, 6);
  });
  it("LONG receives on negative funding", () => {
    expect(fundingPayment({ direction: "LONG", notionalUsd: 10_000, fundingRate: -0.0001 }))
      .toBeCloseTo(-1, 6);
  });
  it("SHORT inverse", () => {
    expect(fundingPayment({ direction: "SHORT", notionalUsd: 10_000, fundingRate: 0.0001 }))
      .toBeCloseTo(-1, 6);
  });
});
