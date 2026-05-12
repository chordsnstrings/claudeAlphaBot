/**
 * Phase 4 performance gate: batch 1000 bars must complete in < 100ms for
 * the heavy compound indicator (ADX, which is the most expensive: it does
 * +DM / -DM / TR and three Wilder-smoothed series).
 */

import { describe, expect, it } from "vitest";

import { adx } from "../../src/indicators/adx.js";
import { atr } from "../../src/indicators/atr.js";
import { rsi } from "../../src/indicators/rsi.js";
import { bollingerBands } from "../../src/indicators/bollinger.js";
import { ema, sma } from "../../src/indicators/moving-averages.js";
import type { OhlcvBar } from "../../src/indicators/types.js";

function syntheticBars(n: number): OhlcvBar[] {
  const out: OhlcvBar[] = [];
  let p = 100;
  for (let i = 0; i < n; i += 1) {
    // Deterministic pseudo-random walk; not Math.random to keep the test
    // reproducible.
    const sin = Math.sin(i * 0.13);
    const cos = Math.cos(i * 0.07);
    const drift = 0.02 * sin + 0.01 * cos;
    p += drift;
    const high = p + 0.05 + Math.abs(sin) * 0.05;
    const low = p - 0.05 - Math.abs(cos) * 0.05;
    out.push({ open: p, high, low, close: p + 0.5 * (high - p) - 0.25 * (p - low) });
  }
  return out;
}

describe("performance gate (spec §9.4)", () => {
  it("batch indicators on 1000 bars in < 100 ms total", () => {
    const bars = syntheticBars(1000);
    const closes = bars.map((b) => b.close);

    const t0 = performance.now();
    const a = atr(bars, 14);
    const r = rsi(closes, 14);
    const d = adx(bars, 14);
    const b = bollingerBands(closes, 20, 2);
    const s = sma(closes, 50);
    const e = ema(closes, 50);
    const elapsed = performance.now() - t0;

    expect(a).toHaveLength(1000);
    expect(r).toHaveLength(1000);
    expect(d).toHaveLength(1000);
    expect(b).toHaveLength(1000);
    expect(s).toHaveLength(1000);
    expect(e).toHaveLength(1000);

    // Comfortable headroom; the spec sets the gate at 100 ms.
    expect(elapsed).toBeLessThan(100);
  });
});
