import { describe, expect, it } from "vitest";

import type { Candle } from "@hydra/shared";

import { classifyRegime, type RegimeClassifierOptions } from "../../src/core/regime.js";

/**
 * Fast classifier tuning for tests: keep the warmup floor at 25 candles
 * (max(emaPeriod + slopeLookback, bbLookback + bbPeriod, atrPeriod)) so
 * synthetic series stay small and obvious to read.
 */
const TEST_OPTS: RegimeClassifierOptions = {
  bbPeriod: 5,
  bbK: 2,
  bbLookback: 20,
  atrPeriod: 5,
  emaPeriod: 10,
  slopeLookback: 3,
  squeezePctile: 20,
  trendSlopePct: 0.05,
  transitionWindow: 2,
};

function buildCandles(closes: readonly number[]): Candle[] {
  return closes.map((close, i) => ({
    symbol: "BTCUSDT" as const,
    openTime: i * 3_600_000,
    closeTime: i * 3_600_000 + 3_599_999,
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 1,
  }));
}

describe("classifyRegime", () => {
  it("returns RANGING with NaN metrics on insufficient data", () => {
    const candles = buildCandles([100, 100, 100]);
    const result = classifyRegime(candles, TEST_OPTS);
    expect(result.regime).toBe("RANGING");
    expect(result.baseRegime).toBe("RANGING");
    expect(result.confidence).toBe(0);
    expect(Number.isNaN(result.bbWidthPctile)).toBe(true);
    expect(Number.isNaN(result.ema99SlopePct)).toBe(true);
  });

  it("classifies flat chop as RANGING", () => {
    // 40 flat candles with tiny alternating noise — slope ≈ 0, no
    // squeeze (bandwidth at median across the trailing window).
    const closes: number[] = [];
    for (let i = 0; i < 40; i++) closes.push(100 + (i % 2 === 0 ? 0.05 : -0.05));
    const result = classifyRegime(buildCandles(closes), TEST_OPTS);
    expect(result.regime).toBe("RANGING");
    expect(result.baseRegime).toBe("RANGING");
    expect(Math.abs(result.ema99SlopePct)).toBeLessThan(0.05);
    // RANGING confidence is (1 − |slope|/threshold), so near 1 for flat.
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("classifies strong uptrend as TRENDING_UP", () => {
    // Geometric growth keeps relative BB width (σ / mean) roughly
    // constant across the whole series, so the last bandwidth is not
    // artificially at the bottom of its trailing distribution (a pure
    // linear ramp would trigger SQUEEZE as mean grows faster than σ).
    // The small sinusoidal perturbation mimics market jitter and avoids
    // floating-point-equal bandwidths tripping `percentileRank`.
    const closes = Array.from(
      { length: 60 },
      (_, i) => 100 * Math.pow(1.01, i) * (1 + Math.sin(i * 0.7) * 0.003),
    );
    const result = classifyRegime(buildCandles(closes), TEST_OPTS);
    expect(result.regime).toBe("TRENDING_UP");
    expect(result.baseRegime).toBe("TRENDING_UP");
    expect(result.ema99SlopePct).toBeGreaterThan(0.05);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("classifies strong downtrend as TRENDING_DOWN", () => {
    const closes = Array.from(
      { length: 60 },
      (_, i) => 200 * Math.pow(0.99, i) * (1 + Math.sin(i * 0.7) * 0.003),
    );
    const result = classifyRegime(buildCandles(closes), TEST_OPTS);
    expect(result.regime).toBe("TRENDING_DOWN");
    expect(result.baseRegime).toBe("TRENDING_DOWN");
    expect(result.ema99SlopePct).toBeLessThan(-0.05);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("classifies compressed tail after volatile history as SQUEEZE", () => {
    // Oscillate for 30 candles (wide BB bandwidth), then flatten for 10
    // (bandwidth collapses to 0). The tail's bandwidth is in the bottom
    // 20% of the trailing 20-width distribution → SQUEEZE.
    const closes: number[] = [];
    for (let i = 0; i < 30; i++) closes.push(100 + (i % 2 === 0 ? 0 : 2));
    for (let i = 30; i < 40; i++) closes.push(100);
    const result = classifyRegime(buildCandles(closes), TEST_OPTS);
    expect(result.regime).toBe("SQUEEZE");
    expect(result.baseRegime).toBe("SQUEEZE");
    expect(result.bbWidthPctile).toBeLessThanOrEqual(20);
    // SQUEEZE confidence ∝ (1 − pctile/20), should be in [0, 1].
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("returns TRANSITION immediately after a regime flip", () => {
    // 48 flat candles (RANGING) then 2 ramping candles that push the
    // current classification into TRENDING_UP. With transitionWindow=2,
    // the classifier compares to idx 47 (still RANGING) and flips to
    // TRANSITION.
    const closes: number[] = [];
    for (let i = 0; i < 48; i++) closes.push(100);
    closes.push(103, 106);
    const result = classifyRegime(buildCandles(closes), TEST_OPTS);
    expect(result.regime).toBe("TRANSITION");
    expect(result.baseRegime).toBe("TRENDING_UP");
    expect(result.confidence).toBe(0.5);
  });

  it("does NOT mark TRANSITION when classification has been stable", () => {
    // Stable exponential uptrend: classification is TRENDING_UP at both
    // `last` and `last − transitionWindow`, so no TRANSITION override.
    const closes = Array.from(
      { length: 60 },
      (_, i) => 100 * Math.pow(1.01, i) * (1 + Math.sin(i * 0.7) * 0.003),
    );
    const result = classifyRegime(buildCandles(closes), TEST_OPTS);
    expect(result.regime).toBe("TRENDING_UP");
    expect(result.regime).toBe(result.baseRegime);
  });

  it("exposes atrPct and raw slope fields in the result", () => {
    const closes = Array.from(
      { length: 60 },
      (_, i) => 100 * Math.pow(1.01, i) * (1 + Math.sin(i * 0.7) * 0.003),
    );
    const result = classifyRegime(buildCandles(closes), TEST_OPTS);
    expect(Number.isFinite(result.atrPct)).toBe(true);
    expect(result.atrPct).toBeGreaterThan(0);
    expect(Number.isFinite(result.ema99Slope)).toBe(true);
    expect(result.ema99Slope).toBeGreaterThan(0);
    // ema99SlopePct = ema99Slope / close × 100
    const lastClose = closes[closes.length - 1]!;
    expect(result.ema99SlopePct).toBeCloseTo((result.ema99Slope / lastClose) * 100, 6);
  });
});
