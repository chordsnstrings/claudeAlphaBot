import { describe, expect, it } from "vitest";

import { computeIndicators } from "../../src/state/compute-indicators.js";
import type { Bar } from "../../src/types/bar.js";

function syntheticBars(n: number): Bar[] {
  const start = Date.parse("2025-01-01T00:00:00Z");
  const out: Bar[] = [];
  let p = 1.1;
  for (let i = 0; i < n; i += 1) {
    p += 0.0001 * Math.sin(i * 0.13);
    out.push({
      instrument: "EURUSD",
      timeframe: "d1",
      timestampUtc: new Date(start + i * 86_400_000),
      open: p,
      high: p + 0.0005,
      low: p - 0.0005,
      close: p,
      volume: 100,
      source: "historical",
    });
  }
  return out;
}

describe("computeIndicators", () => {
  it("returns all-null on too-short input (5 bars)", () => {
    const snap = computeIndicators(syntheticBars(5));
    expect(snap.atr14).toBeNull();
    expect(snap.sma20).toBeNull();
    expect(snap.rsi14).toBeNull();
    expect(snap.adx14).toBeNull();
    expect(snap.bb20).toBeNull();
  });

  it("fills the full snapshot once enough bars are available", () => {
    const snap = computeIndicators(syntheticBars(300));
    expect(snap.atr14).not.toBeNull();
    expect(snap.atr20).not.toBeNull();
    expect(snap.adx14).not.toBeNull();
    expect(snap.sma20).not.toBeNull();
    expect(snap.sma200).not.toBeNull();
    expect(snap.ema20).not.toBeNull();
    expect(snap.ema50).not.toBeNull();
    expect(snap.rsi14).not.toBeNull();
    expect(snap.bb20).not.toBeNull();
    expect(snap.atrPercentile60).not.toBeNull();
    expect(snap.pastReturn252).not.toBeNull();
    expect(snap.rollingHigh20).not.toBeNull();
    expect(snap.rollingHigh55).not.toBeNull();
    expect(snap.rollingLow20).not.toBeNull();
    expect(snap.rollingLow55).not.toBeNull();
  });

  it("rollingHigh20 excludes the current bar", () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 25; i += 1) {
      const high = i === 24 ? 999 : 1;
      bars.push({
        instrument: "EURUSD",
        timeframe: "d1",
        timestampUtc: new Date(2025, 0, i + 1),
        open: 1,
        high,
        low: 0.5,
        close: 1,
        volume: 1,
        source: "historical",
      });
    }
    const snap = computeIndicators(bars);
    // Even though the last bar's high is 999, rollingHigh20 looks at the 20
    // preceding bars (all high=1). Spec: rollingHigh20 EXCLUDES the current bar.
    expect(snap.rollingHigh20).toBe(1);
  });
});
