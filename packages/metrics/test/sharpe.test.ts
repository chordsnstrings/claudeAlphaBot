import { describe, expect, it } from "vitest";

import { bootstrapSharpeCi, calmar, sharpeSortino } from "../src/sharpe.js";

describe("sharpeSortino", () => {
  it("handles too-few returns", () => {
    expect(sharpeSortino({ returns: [] }).sharpe).toBe(0);
    expect(sharpeSortino({ returns: [0.01] }).sharpe).toBe(0);
  });

  it("Sharpe of constant returns is +Infinity-equivalent guard -> 0", () => {
    // stddev=0 -> defined to 0 by the implementation.
    const r = sharpeSortino({ returns: [0.001, 0.001, 0.001, 0.001] });
    expect(r.sharpe).toBe(0);
  });

  it("matches a hand-computed Sharpe", () => {
    // returns mean 0.001/day, stddev ~ 0.01/day.
    const xs = [-0.01, 0.01, -0.005, 0.015, 0.003];
    const r = sharpeSortino({ returns: xs, periodsPerYear: 252 });
    // mean ≈ 0.0026, std ≈ 0.01087; sharpe = 0.0026/0.01087 * sqrt(252) ≈ 3.79
    expect(r.sharpe).toBeGreaterThan(3.5);
    expect(r.sharpe).toBeLessThan(4.5);
  });

  it("Sortino >= Sharpe when downside vol < total vol", () => {
    const xs = [0.02, 0.02, 0.02, -0.005];
    const r = sharpeSortino({ returns: xs });
    expect(r.sortino).toBeGreaterThanOrEqual(r.sharpe);
  });
});

describe("bootstrapSharpeCi", () => {
  it("returns a CI bracketing the point estimate", () => {
    const xs: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      // Slight positive drift with noise.
      xs.push(0.0005 + 0.005 * Math.sin(i * 0.13));
    }
    const ci = bootstrapSharpeCi(xs, { resamples: 1000, seed: 42 });
    expect(ci.lower).toBeLessThanOrEqual(ci.point);
    expect(ci.upper).toBeGreaterThanOrEqual(ci.point);
    expect(ci.resamples).toBe(1000);
  });

  it("is deterministic for the same seed", () => {
    const xs = Array.from({ length: 100 }, (_, i) => 0.0005 + 0.01 * Math.sin(i));
    const a = bootstrapSharpeCi(xs, { resamples: 500, seed: 7 });
    const b = bootstrapSharpeCi(xs, { resamples: 500, seed: 7 });
    expect(a.lower).toBe(b.lower);
    expect(a.upper).toBe(b.upper);
  });
});

describe("calmar", () => {
  it("CAGR / |max_dd_pct|", () => {
    expect(calmar(0.2, -0.1)).toBeCloseTo(2, 8);
    expect(calmar(0.2, 0)).toBe(0);
  });
});
