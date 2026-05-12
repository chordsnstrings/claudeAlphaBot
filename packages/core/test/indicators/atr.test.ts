/**
 * ATR tests.
 *
 * Per Wilder (1978) pp. 21-23, ATR is the Wilder-smoothed True Range.
 *   TR_t = max(High_t - Low_t, |High_t - Close_{t-1}|, |Low_t - Close_{t-1}|)
 *   ATR seed = simple mean of first N TRs
 *   ATR_t   = ((N-1) * ATR_{t-1} + TR_t) / N
 *
 * Tests verify the formula directly on a hand-computable input, plus the
 * boundary cases.
 */

import { describe, expect, it } from "vitest";

import { StreamingAtr, atr, trueRange } from "../../src/indicators/atr.js";
import type { OhlcvBar } from "../../src/indicators/types.js";

function bar(open: number, high: number, low: number, close: number): OhlcvBar {
  return { open, high, low, close };
}

describe("trueRange", () => {
  it("uses high-low when there is no previous close", () => {
    expect(trueRange(bar(10, 12, 9, 11), null)).toBe(3);
  });

  it("picks the max of the three candidates with a previous close", () => {
    // high=12, low=9, prev close=15.
    // candidates: 12-9=3, |12-15|=3, |9-15|=6 -> 6
    expect(trueRange(bar(10, 12, 9, 11), 15)).toBe(6);
  });

  it("handles gap up", () => {
    // prev close=5, high=10, low=8.
    // candidates: 10-8=2, |10-5|=5, |8-5|=3 -> 5
    expect(trueRange(bar(9, 10, 8, 9), 5)).toBe(5);
  });
});

describe("atr", () => {
  it("seeds with the simple mean of the first N TRs", () => {
    // Period 3. Build 5 bars whose TRs are 10, 20, 30, 40, 50.
    // First TR (no prev close) = high - low = 10. Then we engineer subsequent
    // bars so each TR equals the next value.
    //
    // b0: H=10 L=0  C=5   TR=10
    // b1: H=25 L=5  C=20  prev close=5 -> max(20, |25-5|=20, |5-5|=0) = 20
    // b2: H=50 L=20 C=40  prev close=20 -> max(30, |50-20|=30, |20-20|=0) = 30
    // b3: H=80 L=40 C=70  prev close=40 -> max(40, |80-40|=40, |40-40|=0) = 40
    // b4: H=120 L=70 C=110 prev close=70 -> max(50, |120-70|=50, |70-70|=0)=50
    const bars: OhlcvBar[] = [
      bar(0, 10, 0, 5),
      bar(5, 25, 5, 20),
      bar(20, 50, 20, 40),
      bar(40, 80, 40, 70),
      bar(70, 120, 70, 110),
    ];
    const out = atr(bars, 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    // seed: (10+20+30)/3 = 20
    expect(out[2]).toBeCloseTo(20, 10);
    // step: ((3-1)*20 + 40)/3 = 80/3 = 26.6667
    expect(out[3]).toBeCloseTo(80 / 3, 10);
    // step: ((3-1)*80/3 + 50)/3 = (160/3 + 50)/3 = (160/3 + 150/3)/3 = 310/9
    expect(out[4]).toBeCloseTo(310 / 9, 10);
  });

  it("returns nulls when fewer than `period` bars", () => {
    expect(atr([bar(1, 2, 0, 1), bar(1, 2, 0, 1)], 5)).toEqual([null, null]);
  });

  it("StreamingAtr matches batch atr", () => {
    const bars: OhlcvBar[] = [
      bar(0, 10, 0, 5),
      bar(5, 25, 5, 20),
      bar(20, 50, 20, 40),
      bar(40, 80, 40, 70),
      bar(70, 120, 70, 110),
      bar(110, 150, 100, 130),
      bar(130, 170, 120, 160),
    ];
    const batch = atr(bars, 3);
    const stream = new StreamingAtr(3);
    const streamed = bars.map((b) => stream.update(b));
    for (let i = 0; i < bars.length; i += 1) {
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

  it("rejects period < 1", () => {
    expect(() => atr([bar(1, 2, 0, 1)], 0)).toThrow();
  });
});
