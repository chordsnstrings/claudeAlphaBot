import { describe, expect, it } from "vitest";

import { StreamingEma, StreamingSma, ema, sma } from "../../src/indicators/moving-averages.js";

describe("sma", () => {
  it("warms up after `period` samples", () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out).toEqual([null, null, 2, 3, 4]);
  });

  it("handles period larger than input", () => {
    expect(sma([1, 2], 5)).toEqual([null, null]);
  });

  it("rejects period < 1", () => {
    expect(() => sma([1, 2, 3], 0)).toThrow();
  });

  it("StreamingSma matches batch sma", () => {
    const xs = [10, 20, 30, 40, 50, 60, 70];
    const batch = sma(xs, 4);
    const stream = new StreamingSma(4);
    const streamed = xs.map((x) => stream.update(x));
    expect(streamed).toEqual(batch);
    expect(stream.value).toBe(batch[batch.length - 1]);
    expect(stream.samplesSeen).toBe(7);
  });
});

describe("ema", () => {
  it("seeds with SMA then applies alpha = 2/(period+1)", () => {
    // Period 3, alpha = 0.5.
    // Seed (SMA of 1,2,3) = 2. Then 0.5*4 + 0.5*2 = 3. Then 0.5*5 + 0.5*3 = 4.
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(2, 10);
    expect(out[3]).toBeCloseTo(3, 10);
    expect(out[4]).toBeCloseTo(4, 10);
  });

  it("StreamingEma matches batch ema", () => {
    const xs = [22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29];
    const batch = ema(xs, 5);
    const stream = new StreamingEma(5);
    const streamed = xs.map((x) => stream.update(x));
    for (let i = 0; i < xs.length; i += 1) {
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
});
