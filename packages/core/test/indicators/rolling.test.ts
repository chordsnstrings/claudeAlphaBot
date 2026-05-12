import { describe, expect, it } from "vitest";

import {
  atrPercentile,
  pastReturn,
  rollingHigh,
  rollingLow,
} from "../../src/indicators/rolling.js";

describe("rollingHigh / rollingLow", () => {
  it("excludes the current bar", () => {
    const highs = [10, 12, 9, 15, 11, 14];
    // At i=3, window is indices 0..2 = [10, 12, 9] -> max 12, NOT 15.
    const rh = rollingHigh(highs, 3);
    expect(rh[3]).toBe(12);
    expect(rh[4]).toBe(15);
    expect(rh[5]).toBe(15);
  });

  it("returns null for the first `period` indices", () => {
    const rh = rollingHigh([1, 2, 3, 4, 5], 3);
    expect(rh.slice(0, 3).every((v) => v === null)).toBe(true);
    // index 3 = max([1,2,3]) = 3
    expect(rh[3]).toBe(3);
  });

  it("rollingLow excludes the current bar", () => {
    const lows = [10, 8, 11, 5, 9];
    const rl = rollingLow(lows, 3);
    // i=3: window=[10,8,11] -> min 8
    expect(rl[3]).toBe(8);
    // i=4: window=[8,11,5] -> min 5
    expect(rl[4]).toBe(5);
  });

  it("rejects period < 1", () => {
    expect(() => rollingHigh([1, 2], 0)).toThrow();
    expect(() => rollingLow([1, 2], 0)).toThrow();
  });
});

describe("atrPercentile", () => {
  it("requires a full window before emitting", () => {
    const vs: Array<number | null> = [1, 2, 3, 4, 5];
    const out = atrPercentile(vs, 5);
    expect(out.slice(0, 4).every((v) => v === null)).toBe(true);
    // 5 is the max of [1..5] -> rank 5/5 = 1.0
    expect(out[4]).toBe(1);
  });

  it("ranks the current value within the trailing window", () => {
    const vs: Array<number | null> = [1, 5, 2, 4, 3];
    // window 5; index 4 -> window [1,5,2,4,3]; current=3 -> 3 values <=3: 1,2,3 -> 3/5
    const out = atrPercentile(vs, 5);
    expect(out[4]).toBeCloseTo(3 / 5, 10);
  });
});

describe("pastReturn", () => {
  it("computes (now-then)/then", () => {
    const closes = [100, 101, 102, 103, 110];
    const out = pastReturn(closes, 4);
    // index 4: (110 - 100)/100 = 0.10
    expect(out[4]).toBeCloseTo(0.1, 10);
    expect(out.slice(0, 4).every((v) => v === null)).toBe(true);
  });

  it("returns null when the prior close is zero", () => {
    const out = pastReturn([0, 0, 0, 1], 3);
    expect(out[3]).toBeNull();
  });
});
