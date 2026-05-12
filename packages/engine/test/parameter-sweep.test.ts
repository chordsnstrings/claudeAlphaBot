import { describe, expect, it } from "vitest";

import {
  analyseSweep,
  planSweepCombinations,
  type SweepResult,
} from "../src/parameter-sweep.js";

describe("planSweepCombinations", () => {
  it("cross-products parameter values × instruments", () => {
    const combos = planSweepCombinations({
      strategy: "asian-range-sweep",
      instruments: ["EURUSD", "GBPUSD"],
      parameters: {
        minSweepAtr: [0.05, 0.1],
        sweepMaxBars: [10, 15, 20],
      },
      from: new Date("2025-01-01T00:00:00Z"),
      to: new Date("2025-06-01T00:00:00Z"),
    });
    // 2 instruments × 2 minSweepAtr × 3 sweepMaxBars = 12 combos.
    expect(combos).toHaveLength(12);
    expect(combos[0]?.index).toBe(0);
    expect(combos[combos.length - 1]?.index).toBe(11);
    expect(combos[0]?.strategy).toBe("asian-range-sweep");
    expect(combos[0]?.instrument).toBe("EURUSD");
    expect(combos[0]?.parameters).toEqual({ minSweepAtr: 0.05, sweepMaxBars: 10 });
  });

  it("respects isValid filter", () => {
    const combos = planSweepCombinations({
      strategy: "test",
      instruments: ["EURUSD"],
      parameters: { a: [1, 2, 3], b: [10, 20] },
      from: new Date(),
      to: new Date(),
      isValid: (c) => (c.parameters["a"] as number) !== 2,
    });
    // 3 × 2 = 6 total; filter drops a=2 (×2 b values) -> 4.
    expect(combos).toHaveLength(4);
  });

  it("returns [] when instruments empty", () => {
    expect(
      planSweepCombinations({
        strategy: "s",
        instruments: [],
        parameters: { a: [1] },
        from: new Date(),
        to: new Date(),
      }),
    ).toEqual([]);
  });
});

describe("analyseSweep", () => {
  function res(
    idx: number,
    expectancyR: number,
    sharpe: number,
    pValue: number,
    tradeCount = 100,
  ): SweepResult {
    return {
      combination: {
        index: idx,
        strategy: "s",
        instrument: "EURUSD",
        parameters: { p: idx },
      },
      childSessionId: `c${idx}`,
      expectancyR,
      sharpe,
      tradeCount,
      pValue,
    };
  }

  it("computes Bonferroni threshold = 0.05 / N", () => {
    const out = analyseSweep("p", [
      res(0, 0.1, 0.5, 0.01),
      res(1, 0.05, 0.3, 0.02),
      res(2, 0.2, 1.0, 0.001),
      res(3, -0.05, -0.2, 0.5),
    ]);
    expect(out.bonferroniThreshold).toBeCloseTo(0.05 / 4, 8);
  });

  it("flags Bonferroni-significant results", () => {
    const results = [
      res(0, 0.1, 0.5, 0.04), // unadj sig but p > 0.0125
      res(1, 0.2, 1.0, 0.005), // both sig
      res(2, -0.05, -0.2, 0.5),
      res(3, 0.05, 0.3, 0.5),
    ];
    const out = analyseSweep("p", results);
    expect(out.significantUnadjusted.map((r) => r.combination.index)).toEqual([0, 1]);
    expect(out.significantBonferroni.map((r) => r.combination.index)).toEqual([1]);
  });

  it("identifies the best by expectancy and Sharpe", () => {
    const out = analyseSweep("p", [
      res(0, 0.1, 0.5, 0.01),
      res(1, 0.2, 0.3, 0.02), // best expectancy
      res(2, 0.05, 1.0, 0.001), // best Sharpe
    ]);
    expect(out.bestByExpectancy?.combination.index).toBe(1);
    expect(out.bestBySharpe?.combination.index).toBe(2);
  });

  it("detects expectancy plateau within plateauTol", () => {
    const out = analyseSweep(
      "p",
      [
        res(0, 0.1, 0.5, 0.01),
        res(1, 0.11, 0.4, 0.02),
        res(2, 0.12, 0.3, 0.03), // best expectancy
        res(3, -0.1, -0.5, 0.5),
      ],
      { plateauTol: 0.05 },
    );
    // Best = 0.12; band = [0.07, 0.17]. Members: idx 0, 1, 2.
    expect(out.plateauBands.expectancy.center).toBe(0.12);
    expect(out.plateauBands.expectancy.members.map((r) => r.combination.index)).toEqual([
      0, 1, 2,
    ]);
  });
});
