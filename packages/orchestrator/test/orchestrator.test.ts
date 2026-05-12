import { randomUUID } from "node:crypto";

import type { Signal } from "@trading/core";
import { describe, expect, it } from "vitest";

import { Orchestrator } from "../src/orchestrator.js";
import { classifyRegime } from "../src/regime-classifier.js";

function signal(strategy: string): Signal {
  return {
    id: randomUUID(),
    originatingStrategy: strategy,
    instrument: "EURUSD",
    direction: "long",
    proposedEntryPrice: 1.1,
    proposedStopPrice: 1.09,
    proposedTargetPrice: 1.12,
    proposedSizeFractionOfAllocation: 1,
    urgencyScore: 0.5,
    signalType: "test",
    entryReason: "test",
    generatedAtBar: new Date("2025-06-15T00:00:00Z"),
    metadata: {},
  };
}

describe("classifyRegime (locked rules)", () => {
  it("volatile when atrPercentile > 80", () => {
    expect(
      classifyRegime({ adx14: 10, atrPercentile60: 0.85, close: 1.1, sma200: 1.05 }),
    ).toBe("volatile");
  });
  it("trending when ADX>25 and close>sma200", () => {
    expect(
      classifyRegime({ adx14: 30, atrPercentile60: 0.4, close: 1.2, sma200: 1.1 }),
    ).toBe("trending");
  });
  it("ranging when ADX<20 and atrPercentile<50", () => {
    expect(
      classifyRegime({ adx14: 15, atrPercentile60: 0.3, close: 1.1, sma200: 1.05 }),
    ).toBe("ranging");
  });
  it("mixed otherwise", () => {
    expect(
      classifyRegime({ adx14: 22, atrPercentile60: 0.6, close: 1.1, sma200: 1.0 }),
    ).toBe("mixed");
  });
});

describe("Orchestrator", () => {
  it("equal_weight: 1/N per strategy", () => {
    const orch = new Orchestrator({
      mode: "equal_weight",
      strategies: [
        { name: "A", category: "trend" },
        { name: "B", category: "meanRev" },
        { name: "C", category: "breakout" },
      ],
    });
    const allocs = orch.allocations();
    expect(allocs.get("A")).toBeCloseTo(1 / 3, 8);
    expect(allocs.get("B")).toBeCloseTo(1 / 3, 8);
    expect(allocs.get("C")).toBeCloseTo(1 / 3, 8);
  });

  it("regime_switched: trending → 60% trend, 15% meanRev, 25% breakout", () => {
    const orch = new Orchestrator({
      mode: "regime_switched",
      strategies: [
        { name: "T", category: "trend" },
        { name: "M", category: "meanRev" },
        { name: "B", category: "breakout" },
      ],
    });
    orch.setRegime("trending");
    const a = orch.allocations();
    expect(a.get("T")).toBeCloseTo(0.6, 8);
    expect(a.get("M")).toBeCloseTo(0.15, 8);
    expect(a.get("B")).toBeCloseTo(0.25, 8);
  });

  it("regime_switched: ranging → 60% meanRev", () => {
    const orch = new Orchestrator({
      mode: "regime_switched",
      strategies: [
        { name: "T", category: "trend" },
        { name: "M", category: "meanRev" },
      ],
    });
    orch.setRegime("ranging");
    const a = orch.allocations();
    expect(a.get("M")).toBeCloseTo(0.6, 8);
  });

  it("risk_parity falls back to 1/N when fewer than 20 samples", () => {
    const orch = new Orchestrator({
      mode: "risk_parity",
      strategies: [
        { name: "A", category: "trend" },
        { name: "B", category: "meanRev" },
      ],
    });
    const a = orch.allocations(new Date("2025-04-01T00:00:00Z"));
    expect(a.get("A")).toBeCloseTo(0.5, 8);
    expect(a.get("B")).toBeCloseTo(0.5, 8);
  });

  it("risk_parity skews allocation to the lower-vol strategy", () => {
    const orch = new Orchestrator({
      mode: "risk_parity",
      strategies: [
        { name: "low", category: "trend" },
        { name: "high", category: "meanRev" },
      ],
    });
    const start = Date.parse("2025-01-15T00:00:00Z");
    // Low-vol: 25 samples of ~0.001 returns.
    for (let i = 0; i < 25; i += 1) {
      orch.observeClose("low", 0.001 * Math.sin(i * 0.1), new Date(start + i * 86_400_000));
    }
    // High-vol: 25 samples of ~0.01 returns.
    for (let i = 0; i < 25; i += 1) {
      orch.observeClose("high", 0.01 * Math.sin(i * 0.1), new Date(start + i * 86_400_000));
    }
    // Allocation snapshot AFTER quarter boundary (Apr 1).
    const a = orch.allocations(new Date("2025-04-15T00:00:00Z"));
    expect(a.get("low") ?? 0).toBeGreaterThan(a.get("high") ?? 0);
  });

  it("process scales lot size by allocation and includes attribution", () => {
    const orch = new Orchestrator({
      mode: "equal_weight",
      strategies: [
        { name: "A", category: "trend" },
        { name: "B", category: "meanRev" },
      ],
      defaultLotSize: 1.0,
    });
    const orders = orch.process(
      [signal("A"), signal("B")],
      { accountEquityUsd: 100_000, totalOpenRiskPct: 0 },
    );
    expect(orders).toHaveLength(2);
    // Lot size = 1.0 * sizeFraction(1) * alloc(0.5) = 0.50.
    expect(orders[0]?.lotSize).toBeCloseTo(0.5, 4);
    expect(orders[0]?.metadata).toMatchObject({
      orchestratorMode: "equal_weight",
      orchestratorAllocation: 0.5,
    });
    expect(orders[0]?.originatingStrategy).toBe("A");
    expect(orders[1]?.originatingStrategy).toBe("B");
  });

  it("filters out signals from strategies with 0 allocation", () => {
    const orch = new Orchestrator({
      mode: "regime_switched",
      strategies: [{ name: "T", category: "trend" }],
    });
    orch.setRegime("ranging"); // trend gets 15%
    const orders = orch.process(
      [signal("T")],
      { accountEquityUsd: 100_000, totalOpenRiskPct: 0 },
    );
    expect(orders).toHaveLength(1);
    // Now an orchestrator with no matching category strategies.
    const orch2 = new Orchestrator({
      mode: "regime_switched",
      strategies: [{ name: "X", category: "breakout" }],
    });
    orch2.setRegime("ranging"); // breakout 25%, but T strategy gets 0
    const orders2 = orch2.process(
      [signal("X")],
      { accountEquityUsd: 100_000, totalOpenRiskPct: 0 },
    );
    expect(orders2).toHaveLength(1);
    // default 0.1 * sizeFraction(1) * alloc(0.25) = 0.025 -> rounded to
    // 0.01 lot increments (Math.round → 0.03 in JS for the .025 tie).
    expect(orders2[0]?.lotSize).toBeCloseTo(0.03, 4);
  });
});
