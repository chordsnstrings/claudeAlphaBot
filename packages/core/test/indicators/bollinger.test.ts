import { describe, expect, it } from "vitest";

import {
  StreamingBollinger,
  bollingerBands,
} from "../../src/indicators/bollinger.js";

describe("bollingerBands", () => {
  it("computes middle, upper, lower correctly on a known input", () => {
    // values 1,2,3,4,5 — period 5, 2 stdDevs.
    // mean = 3; population variance = sum((x-3)^2)/5 = (4+1+0+1+4)/5 = 2
    // stddev = sqrt(2) ≈ 1.4142135623730951
    const out = bollingerBands([1, 2, 3, 4, 5], 5, 2);
    const last = out[4];
    expect(last).not.toBeNull();
    if (last !== null) {
      expect(last.middle).toBeCloseTo(3, 10);
      expect(last.stddev).toBeCloseTo(Math.sqrt(2), 10);
      expect(last.upper).toBeCloseTo(3 + 2 * Math.sqrt(2), 10);
      expect(last.lower).toBeCloseTo(3 - 2 * Math.sqrt(2), 10);
    }
  });

  it("returns nulls until the period is reached", () => {
    const out = bollingerBands([1, 2, 3, 4, 5], 5, 2);
    expect(out.slice(0, 4).every((v) => v === null)).toBe(true);
  });

  it("StreamingBollinger matches batch", () => {
    const xs = [10, 11, 12, 13, 14, 15, 16, 15, 14, 13, 12, 11];
    const batch = bollingerBands(xs, 5, 2);
    const stream = new StreamingBollinger(5, 2);
    const streamed = xs.map((x) => stream.update(x));
    for (let i = 0; i < xs.length; i += 1) {
      const b = batch[i];
      const s = streamed[i];
      if (b === null) {
        expect(s).toBeNull();
      } else {
        expect(s).not.toBeNull();
        if (s !== null) {
          expect(s.middle).toBeCloseTo(b.middle, 10);
          expect(s.upper).toBeCloseTo(b.upper, 10);
          expect(s.lower).toBeCloseTo(b.lower, 10);
          expect(s.stddev).toBeCloseTo(b.stddev, 10);
        }
      }
    }
  });

  it("rejects bad parameters", () => {
    expect(() => bollingerBands([1, 2, 3], 0, 2)).toThrow();
    expect(() => bollingerBands([1, 2, 3], 2, 0)).toThrow();
  });
});
