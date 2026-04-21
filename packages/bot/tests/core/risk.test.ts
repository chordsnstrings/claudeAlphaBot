import { describe, expect, it } from "vitest";

import {
  DEFAULT_SYMBOL_META,
  sizePosition,
  type SizingInputs,
} from "../../src/core/risk.js";

const BTC = DEFAULT_SYMBOL_META.BTCUSDT;

describe("sizePosition — formula", () => {
  it("$5000 equity, 2% risk, 1% stop, $50K price → $10K notional, 0.2 BTC", () => {
    const inputs: SizingInputs = {
      accountEquity: 5_000,
      entryPrice: 50_000,
      stopPrice: 49_500, // 1% below
      openNotionalsSum: 0,
      symbolMeta: BTC,
    };
    const r = sizePosition(inputs);
    expect(r.type).toBe("OK");
    if (r.type !== "OK") return;
    expect(r.riskUsd).toBeCloseTo(100, 6);
    expect(r.notionalUsd).toBeCloseTo(10_000, 6);
    expect(r.quantity).toBeCloseTo(0.2, 6);
    expect(r.marginUsd).toBeCloseTo(500, 6); // 10000 / 20
    expect(r.partial).toBe(false);
  });

  it("matches spec §2.4 worked example exactly", () => {
    // equity $5000, entry 67520, stop 66690 → risk 100, notional 8136, qty 0.1205, margin 407
    const r = sizePosition({
      accountEquity: 5_000,
      entryPrice: 67_520,
      stopPrice: 66_690,
      openNotionalsSum: 0,
      symbolMeta: BTC,
    });
    if (r.type !== "OK") throw new Error("expected OK");
    expect(r.riskUsd).toBeCloseTo(100, 6);
    // raw notional = 100 / (830/67520) = 100 * 67520/830 = 8134.94
    // qty raw = 8134.94/67520 = 0.120483 → floor to 0.001 step = 0.120
    // notional = 0.120 * 67520 = 8102.4
    expect(r.quantity).toBe(0.12);
    expect(r.notionalUsd).toBeCloseTo(8_102.4, 4);
    expect(r.marginUsd).toBeCloseTo(8_102.4 / 20, 4);
  });
});

describe("sizePosition — quantity rounding", () => {
  it("rounds DOWN to step size, never up", () => {
    // Raw qty 0.1205 with step 0.001 → 0.120 (not 0.121).
    const r = sizePosition({
      accountEquity: 5_000,
      entryPrice: 67_520,
      stopPrice: 66_690,
      openNotionalsSum: 0,
      symbolMeta: { symbol: "BTCUSDT", stepSize: 0.001, minQty: 0.001 },
    });
    if (r.type !== "OK") throw new Error("expected OK");
    expect(r.quantity).toBe(0.12);
  });

  it("rejects when rounded qty is zero (raw qty < step size)", () => {
    // Risk so small the raw qty rounds to zero with step 1.
    const r = sizePosition({
      accountEquity: 1, // 0.02 risk
      entryPrice: 50_000,
      stopPrice: 49_500,
      openNotionalsSum: 0,
      symbolMeta: { symbol: "SOLUSDT", stepSize: 1, minQty: 1 },
    });
    expect(r.type).toBe("REJECT");
    if (r.type === "REJECT") expect(r.reason).toBe("QUANTITY_ROUNDS_TO_ZERO");
  });
});

describe("sizePosition — minimum notional", () => {
  it("rejects when notional < $5", () => {
    const r = sizePosition({
      accountEquity: 100,
      entryPrice: 50_000,
      stopPrice: 49_500, // 1%
      openNotionalsSum: 0,
      symbolMeta: BTC,
      opts: { minNotionalUsd: 5 },
    });
    // risk=2, notional=200, qty raw=0.004, floor to 0.004, notional=200 — passes 5.
    // Make stop tighter to shrink notional.
    expect(r.type).toBe("OK");

    // Now use $5 equity: risk=$0.10, notional=$10, qty raw=0.0002 → floor to 0 → REJECT first as QUANTITY_ROUNDS_TO_ZERO.
    const r2 = sizePosition({
      accountEquity: 1,
      entryPrice: 50_000,
      stopPrice: 49_500,
      openNotionalsSum: 0,
      symbolMeta: BTC,
    });
    expect(r2.type).toBe("REJECT");

    // Force min-notional path: large enough to round, but notional just under $5.
    const r3 = sizePosition({
      accountEquity: 0.5,
      entryPrice: 1_000,
      stopPrice: 990, // 1%
      openNotionalsSum: 0,
      symbolMeta: { symbol: "BTCUSDT", stepSize: 0.001, minQty: 0.001 },
      opts: { minNotionalUsd: 5 },
    });
    // risk = 0.01, notional = 1, qty raw = 0.001 (rounded), notional = 1 < 5 → reject min-notional
    expect(r3.type).toBe("REJECT");
    if (r3.type === "REJECT") expect(r3.reason).toBe("BELOW_MIN_NOTIONAL");
  });
});

describe("sizePosition — exposure caps (§6.5)", () => {
  it("enters at full size when desired ≤ headroom", () => {
    const r = sizePosition({
      accountEquity: 5_000,
      entryPrice: 50_000,
      stopPrice: 49_500,
      openNotionalsSum: 1_000, // headroom = 12500-1000 = 11500 ≥ 10000 desired
      symbolMeta: BTC,
    });
    if (r.type !== "OK") throw new Error("expected OK");
    expect(r.partial).toBe(false);
    expect(r.notionalUsd).toBeCloseTo(10_000, 6);
  });

  it("scales to headroom when 0.2 ≤ headroom/desired < 1", () => {
    // max = 2.5*5000 = 12500, used 8000 → headroom 4500.
    // desired = 10000. ratio = 4500/10000 = 0.45 ≥ 0.2 → enter at 4500.
    const r = sizePosition({
      accountEquity: 5_000,
      entryPrice: 50_000,
      stopPrice: 49_500,
      openNotionalsSum: 8_000,
      symbolMeta: BTC,
    });
    if (r.type !== "OK") throw new Error("expected OK");
    expect(r.partial).toBe(true);
    // qty raw = 4500/50000 = 0.09 → step 0.001 → 0.090
    expect(r.quantity).toBeCloseTo(0.09, 6);
    expect(r.notionalUsd).toBeCloseTo(4_500, 6);
  });

  it("REJECTS when headroom/desired < 0.2", () => {
    // headroom 1000, desired 10000 → ratio 0.1 < 0.2.
    const r = sizePosition({
      accountEquity: 5_000,
      entryPrice: 50_000,
      stopPrice: 49_500,
      openNotionalsSum: 11_500,
      symbolMeta: BTC,
    });
    expect(r.type).toBe("REJECT");
    if (r.type === "REJECT") expect(r.reason).toBe("EXPOSURE_HEADROOM_TOO_SMALL");
  });

  it("REJECTS when headroom is zero (already at exposure cap)", () => {
    const r = sizePosition({
      accountEquity: 5_000,
      entryPrice: 50_000,
      stopPrice: 49_500,
      openNotionalsSum: 12_500,
      symbolMeta: BTC,
    });
    expect(r.type).toBe("REJECT");
    if (r.type === "REJECT") expect(r.reason).toBe("EXPOSURE_HEADROOM_TOO_SMALL");
  });
});

describe("sizePosition — degenerate inputs", () => {
  it("rejects on zero stop distance", () => {
    const r = sizePosition({
      accountEquity: 5_000,
      entryPrice: 50_000,
      stopPrice: 50_000,
      openNotionalsSum: 0,
      symbolMeta: BTC,
    });
    expect(r.type).toBe("REJECT");
    if (r.type === "REJECT") expect(r.reason).toBe("ZERO_STOP_DISTANCE");
  });
});
