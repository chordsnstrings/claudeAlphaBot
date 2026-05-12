/**
 * RSI tests.
 *
 * Wilder, "New Concepts in Technical Trading Systems" (1978), pp 63-67
 * defines RSI as 100 - 100/(1+RS) with Wilder smoothing of avg gain and
 * avg loss. Tests below verify:
 *   1. The defining mathematical formula on a tiny hand-computable input.
 *   2. Boundary behaviour: monotonic-up = 100, monotonic-down = 0,
 *      constant = 50.
 *   3. Streaming = batch.
 */

import { describe, expect, it } from "vitest";

import { StreamingRsi, rsi } from "../../src/indicators/rsi.js";

describe("rsi", () => {
  it("matches hand calculation on a tractable input", () => {
    // 15 closes -> 14 changes -> RSI emitted at index 14.
    // Changes: +1,+1,+1,+1,-1,+1,+1,-1,+1,+1,-1,+1,+1,-1
    // Sum of gains = 10, sum of losses = 4 across 14 changes.
    // avgGain = 10/14, avgLoss = 4/14, RS = 2.5, RSI = 100 - 100/3.5 = 71.4286
    const closes = [1, 2, 3, 4, 5, 4, 5, 6, 5, 6, 7, 6, 7, 8, 7];
    const out = rsi(closes, 14);
    expect(out.slice(0, 14).every((v) => v === null)).toBe(true);
    expect(out[14]).not.toBeNull();
    expect(out[14] as number).toBeCloseTo(71.42857142857143, 8);
  });

  it("returns 100 for a strictly increasing series", () => {
    const closes = Array.from({ length: 30 }, (_, i) => i + 1);
    const out = rsi(closes, 14);
    expect(out[14]).toBe(100);
    expect(out[29]).toBe(100);
  });

  it("returns 0 for a strictly decreasing series", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 - i);
    const out = rsi(closes, 14);
    // avgGain = 0; RS undefined -> RSI = 0 by formula (1+RS) collapses.
    expect(out[14]).toBe(0);
  });

  it("returns 50 for a constant series (no movement)", () => {
    const closes = Array.from({ length: 30 }, () => 50);
    const out = rsi(closes, 14);
    expect(out[14]).toBe(50);
  });

  it("StreamingRsi matches batch rsi", () => {
    const closes = [1, 2, 3, 4, 5, 4, 5, 6, 5, 6, 7, 6, 7, 8, 7, 8, 9, 8];
    const batch = rsi(closes, 14);
    const stream = new StreamingRsi(14);
    const streamed = closes.map((c) => stream.update(c));
    for (let i = 0; i < closes.length; i += 1) {
      const b = batch[i];
      const s = streamed[i];
      if (b === null) {
        expect(s).toBeNull();
      } else {
        expect(s).not.toBeNull();
        expect(s as number).toBeCloseTo(b, 10);
      }
    }
  });

  it("returns nulls when there are not enough closes", () => {
    expect(rsi([1, 2, 3], 14)).toEqual([null, null, null]);
  });

  it("rejects period < 1", () => {
    expect(() => rsi([1, 2, 3], 0)).toThrow();
  });
});
