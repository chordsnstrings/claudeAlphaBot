/**
 * ADX tests.
 *
 * Wilder (1978, pp. 35-47) defines ADX through the +DI, -DI, DX chain. The
 * math is involved; rather than copy a tabulated reference (which differs
 * across implementations by rounding and seeding choices), these tests
 * exercise:
 *   1. Structural correctness: warm-up index, every output well-formed.
 *   2. Trending vs choppy behaviour: ADX rises in a clean uptrend and
 *      stays low in a sideways series.
 *   3. Streaming = batch.
 */

import { describe, expect, it } from "vitest";

import { StreamingAdx, adx } from "../../src/indicators/adx.js";
import type { OhlcvBar } from "../../src/indicators/types.js";

function bar(open: number, high: number, low: number, close: number): OhlcvBar {
  return { open, high, low, close };
}

function uptrendBars(n: number): OhlcvBar[] {
  // Each bar moves +1 from the previous, with a 0.5-wide range.
  const out: OhlcvBar[] = [];
  let p = 100;
  for (let i = 0; i < n; i += 1) {
    const open = p;
    const close = p + 1;
    out.push(bar(open, close + 0.25, open - 0.25, close));
    p = close;
  }
  return out;
}

function sidewaysBars(n: number): OhlcvBar[] {
  const out: OhlcvBar[] = [];
  for (let i = 0; i < n; i += 1) {
    // small noise around 100
    const r = (i % 4) - 1.5; // -1.5..1.5
    const open = 100 + r * 0.1;
    const close = 100 - r * 0.1;
    out.push(bar(open, 100.2, 99.8, close));
  }
  return out;
}

describe("adx", () => {
  it("first ADX appears at index 2*period - 1", () => {
    const bars = uptrendBars(40);
    const out = adx(bars, 14);
    // 0 .. 2*14-2 = 0..27 should be null; 28 should be the first ADX.
    for (let i = 0; i < 27; i += 1) {
      expect(out[i]).toBeNull();
    }
    expect(out[27]).not.toBeNull();
  });

  it("rises above 25 on a clean uptrend (Wilder's trending threshold)", () => {
    const bars = uptrendBars(50);
    const out = adx(bars, 14);
    const tail = out[out.length - 1];
    expect(tail).not.toBeNull();
    if (tail !== null) {
      expect(tail.adx).toBeGreaterThan(25);
      // +DI should dominate -DI in an uptrend.
      expect(tail.plusDi).toBeGreaterThan(tail.minusDi);
    }
  });

  it("stays low on a sideways series", () => {
    const bars = sidewaysBars(60);
    const out = adx(bars, 14);
    const tail = out[out.length - 1];
    expect(tail).not.toBeNull();
    if (tail !== null) {
      // No directional movement -> ADX near 0.
      expect(tail.adx).toBeLessThan(30);
    }
  });

  it("StreamingAdx matches batch adx", () => {
    const bars = uptrendBars(40);
    const batch = adx(bars, 14);
    const stream = new StreamingAdx(14);
    const streamed = bars.map((b) => stream.update(b));
    for (let i = 0; i < bars.length; i += 1) {
      const b = batch[i];
      const s = streamed[i];
      if (b === null) {
        expect(s).toBeNull();
      } else {
        expect(s).not.toBeNull();
        if (s !== null) {
          expect(s.adx).toBeCloseTo(b.adx, 8);
          expect(s.plusDi).toBeCloseTo(b.plusDi, 8);
          expect(s.minusDi).toBeCloseTo(b.minusDi, 8);
        }
      }
    }
  });

  it("rejects period < 1", () => {
    expect(() => adx([bar(1, 2, 0, 1)], 0)).toThrow();
  });
});
