/**
 * Phase 13 strategies — Donchian Breakout, Trend Following, Bollinger
 * Reversal. Unit tests use synthetic IndicatorSnapshot inputs to
 * exercise the entry logic of each.
 */

import {
  type Bar,
  type IndicatorSnapshot,
  type MarketState,
  type SessionContext,
} from "@trading/core";
import { describe, expect, it } from "vitest";

import { BollingerReversalStrategy } from "../src/bollinger-reversal.js";
import { DonchianBreakoutStrategy } from "../src/donchian-breakout.js";
import { TrendFollowingStrategy } from "../src/trend-following.js";

function emptyIndicators(): IndicatorSnapshot {
  return {
    atr14: null,
    atr20: null,
    adx14: null,
    sma20: null,
    sma50: null,
    sma100: null,
    sma200: null,
    ema20: null,
    ema50: null,
    rsi14: null,
    bb20: null,
    atrPercentile60: null,
    pastReturn252: null,
    rollingHigh20: null,
    rollingHigh55: null,
    rollingLow20: null,
    rollingLow55: null,
  };
}

function emptySession(): SessionContext {
  return {
    asianHigh: null,
    asianLow: null,
    currentSession: "closed",
    secondsToSessionClose: 0,
    isInNewsWindow: false,
  };
}

function state(bar: Bar, ind: Partial<IndicatorSnapshot>): MarketState {
  return {
    currentBar: bar,
    instrument: bar.instrument,
    recentBars: [bar],
    indicators: { ...emptyIndicators(), ...ind },
    sessionContext: emptySession(),
    currentPositions: [],
    accountEquity: 100_000,
    now: bar.timestampUtc,
  };
}

function daily(close: number, high = close + 0.001, low = close - 0.001): Bar {
  return {
    instrument: "EURUSD",
    timeframe: "d1",
    timestampUtc: new Date("2025-06-01T00:00:00Z"),
    open: close,
    high,
    low,
    close,
    volume: 100,
    source: "historical",
  };
}

// ----------------------------------------------------- Donchian Breakout

describe("DonchianBreakoutStrategy", () => {
  it("emits long when close > rolling20 high and ATR-pct in band", async () => {
    const s = new DonchianBreakoutStrategy("EURUSD");
    const sigs = await s.generateSignals(
      state(daily(1.101), {
        rollingHigh20: 1.1,
        rollingLow20: 1.09,
        atr14: 0.005,
        atrPercentile60: 0.5,
      }),
    );
    expect(sigs).toHaveLength(1);
    expect(sigs[0]?.direction).toBe("long");
    expect(sigs[0]?.proposedStopPrice).toBeCloseTo(1.101 - 2 * 0.005, 8);
  });

  it("emits short when close < rolling20 low", async () => {
    const s = new DonchianBreakoutStrategy("EURUSD");
    const sigs = await s.generateSignals(
      state(daily(1.089), {
        rollingHigh20: 1.1,
        rollingLow20: 1.09,
        atr14: 0.005,
        atrPercentile60: 0.5,
      }),
    );
    expect(sigs[0]?.direction).toBe("short");
  });

  it("skips when ATR percentile is below 0.2 (chop)", async () => {
    const s = new DonchianBreakoutStrategy("EURUSD");
    const sigs = await s.generateSignals(
      state(daily(1.101), {
        rollingHigh20: 1.1,
        rollingLow20: 1.09,
        atr14: 0.005,
        atrPercentile60: 0.1,
      }),
    );
    expect(sigs).toHaveLength(0);
  });
});

// ------------------------------------------------------ Trend Following

describe("TrendFollowingStrategy", () => {
  it("emits long when pastReturn252 > 0 and SMA50 > SMA200", async () => {
    const s = new TrendFollowingStrategy("EURUSD");
    const sigs = await s.generateSignals(
      state(daily(1.1), {
        atr14: 0.005,
        sma50: 1.105,
        sma200: 1.095,
        pastReturn252: 0.05,
      }),
    );
    expect(sigs[0]?.direction).toBe("long");
    expect(sigs[0]?.proposedStopPrice).toBeCloseTo(1.1 - 3 * 0.005, 8);
  });

  it("emits short when pastReturn252 < 0 and SMA50 < SMA200", async () => {
    const s = new TrendFollowingStrategy("EURUSD");
    const sigs = await s.generateSignals(
      state(daily(1.1), {
        atr14: 0.005,
        sma50: 1.09,
        sma200: 1.1,
        pastReturn252: -0.05,
      }),
    );
    expect(sigs[0]?.direction).toBe("short");
  });

  it("does nothing if the trend signals disagree", async () => {
    const s = new TrendFollowingStrategy("EURUSD");
    const sigs = await s.generateSignals(
      state(daily(1.1), {
        atr14: 0.005,
        sma50: 1.105,
        sma200: 1.1,
        pastReturn252: -0.01,
      }),
    );
    expect(sigs).toHaveLength(0);
  });
});

// ---------------------------------------------------- Bollinger Reversal

describe("BollingerReversalStrategy", () => {
  it("enters short after close-above-band then close-back-inside", async () => {
    const s = new BollingerReversalStrategy("EURUSD");
    // Day 1: close above upper.
    let sigs = await s.generateSignals(
      state(daily(1.105, 1.108, 1.103), {
        bb20: { middle: 1.1, upper: 1.103, lower: 1.097, stddev: 0.0015 },
      }),
    );
    expect(sigs).toHaveLength(0);
    // Day 2: close back inside the upper band.
    sigs = await s.generateSignals(
      state(daily(1.101, 1.106, 1.0995), {
        bb20: { middle: 1.1, upper: 1.103, lower: 1.097, stddev: 0.0015 },
      }),
    );
    expect(sigs).toHaveLength(1);
    expect(sigs[0]?.direction).toBe("short");
    // Stop above the tracked extreme (1.108 + buffer).
    expect(sigs[0]?.proposedStopPrice).toBeCloseTo(1.108 + 1.5 * 0.0001, 6);
  });

  it("enters long after close-below-band then close-back-inside", async () => {
    const s = new BollingerReversalStrategy("EURUSD");
    let sigs = await s.generateSignals(
      state(daily(1.095, 1.097, 1.092), {
        bb20: { middle: 1.1, upper: 1.103, lower: 1.097, stddev: 0.0015 },
      }),
    );
    expect(sigs).toHaveLength(0);
    sigs = await s.generateSignals(
      state(daily(1.099, 1.1, 1.094), {
        bb20: { middle: 1.1, upper: 1.103, lower: 1.097, stddev: 0.0015 },
      }),
    );
    expect(sigs[0]?.direction).toBe("long");
    expect(sigs[0]?.proposedStopPrice).toBeCloseTo(1.092 - 1.5 * 0.0001, 6);
  });

  it("targets the SMA20 middle by default", async () => {
    const s = new BollingerReversalStrategy("EURUSD");
    await s.generateSignals(
      state(daily(1.105, 1.108, 1.103), {
        bb20: { middle: 1.1, upper: 1.103, lower: 1.097, stddev: 0.0015 },
      }),
    );
    const [sig] = await s.generateSignals(
      state(daily(1.101, 1.106, 1.0995), {
        bb20: { middle: 1.1, upper: 1.103, lower: 1.097, stddev: 0.0015 },
      }),
    );
    expect(sig?.proposedTargetPrice).toBeCloseTo(1.1, 8);
  });
});
