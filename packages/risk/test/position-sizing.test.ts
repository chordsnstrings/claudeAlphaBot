import { randomUUID } from "node:crypto";

import { DEFAULT_RISK_CONFIG, type Signal } from "@trading/core";
import { describe, expect, it } from "vitest";

import { computeLotSize, riskUsdForOrder } from "../src/position-sizing.js";

function sig(entry: number, stop: number, instrument = "EURUSD"): Signal {
  return {
    id: randomUUID(),
    originatingStrategy: "test",
    instrument,
    direction: "long",
    proposedEntryPrice: entry,
    proposedStopPrice: stop,
    proposedTargetPrice: entry * 1.001,
    proposedSizeFractionOfAllocation: 1,
    urgencyScore: 0.5,
    signalType: "test",
    entryReason: "test",
    generatedAtBar: new Date(),
    metadata: {},
  };
}

describe("computeLotSize (percentage-based scaling)", () => {
  it("Same risk config at $1K vs $10K vs $100K -> proportional positions", () => {
    const signal = sig(1.1, 1.09); // 100 pip stop on EURUSD = $1000/lot risk
    const cfg = { ...DEFAULT_RISK_CONFIG, riskPerTradePct: 1.0 };

    // riskPerTradePct=1%, stop=100pips=$1000/lot.
    // At $1K equity: dollarRisk=$10 -> lot=$10/$1000=0.01
    // At $10K:      dollarRisk=$100 -> lot=0.10
    // At $100K:     dollarRisk=$1000 -> lot=1.00
    const s1 = computeLotSize({
      signal,
      accountEquityUsd: 1_000,
      riskConfig: cfg,
      currentDrawdownPct: 0,
    });
    const s10 = computeLotSize({
      signal,
      accountEquityUsd: 10_000,
      riskConfig: cfg,
      currentDrawdownPct: 0,
    });
    const s100 = computeLotSize({
      signal,
      accountEquityUsd: 100_000,
      riskConfig: cfg,
      currentDrawdownPct: 0,
    });

    expect(s1).toBeCloseTo(0.01, 4);
    expect(s10).toBeCloseTo(0.1, 4);
    expect(s100).toBeCloseTo(1.0, 4);
  });

  it("halves the size when drawdown exceeds drawdownSoftReducePct", () => {
    const signal = sig(1.1, 1.09);
    const cfg = { ...DEFAULT_RISK_CONFIG, riskPerTradePct: 1.0 };
    const normal = computeLotSize({
      signal,
      accountEquityUsd: 100_000,
      riskConfig: cfg,
      currentDrawdownPct: 0,
    });
    const halved = computeLotSize({
      signal,
      accountEquityUsd: 100_000,
      riskConfig: cfg,
      currentDrawdownPct: cfg.drawdownSoftReducePct + 0.01,
    });
    expect(halved).toBeCloseTo(normal / 2, 4);
  });

  it("returns 0 if computed lot < 0.01", () => {
    const signal = sig(1.1, 1.09);
    const cfg = { ...DEFAULT_RISK_CONFIG, riskPerTradePct: 0.001 };
    const out = computeLotSize({
      signal,
      accountEquityUsd: 1_000,
      riskConfig: cfg,
      currentDrawdownPct: 0,
    });
    expect(out).toBe(0);
  });

  it("rejects zero stop distance", () => {
    const signal = sig(1.1, 1.1);
    const out = computeLotSize({
      signal,
      accountEquityUsd: 100_000,
      riskConfig: DEFAULT_RISK_CONFIG,
      currentDrawdownPct: 0,
    });
    expect(out).toBe(0);
  });
});

describe("riskUsdForOrder", () => {
  it("USD risk = stop_distance * 100k * lot for FX", () => {
    expect(riskUsdForOrder("EURUSD", 1.1, 1.09, 1)).toBeCloseTo(1000, 4);
    expect(riskUsdForOrder("EURUSD", 1.1, 1.09, 0.1)).toBeCloseTo(100, 4);
  });

  it("XAUUSD uses 100 oz/lot", () => {
    expect(riskUsdForOrder("XAUUSD", 2000, 1990, 0.1)).toBeCloseTo(100, 4);
  });
});
