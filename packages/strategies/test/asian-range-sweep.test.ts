/**
 * AsianRangeSweepStrategy unit tests with synthetic M1 bars constructed
 * to exhibit specific sweep-and-reversal scenarios.
 *
 * The strategy depends on daily ATR injected via dataFeed.getHistoricalBars
 * during `initialize()`; tests provide a stub feed that returns a single
 * daily bar with a known true-range so ATR(14) = that value.
 */

import { randomUUID } from "node:crypto";

import {
  type Bar,
  type IndicatorSnapshot,
  type MarketDataFeed,
  type MarketState,
  type SessionContext,
  type Timeframe,
} from "@trading/core";
import { describe, expect, it } from "vitest";

import { AsianRangeSweepStrategy } from "../src/asian-range-sweep.js";

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

function mkBar(isoTs: string, o: number, h: number, l: number, c: number): Bar {
  return {
    instrument: "EURUSD",
    timeframe: "m1",
    timestampUtc: new Date(isoTs),
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 100,
    source: "historical",
  };
}

function makeState(bar: Bar): MarketState {
  return {
    currentBar: bar,
    instrument: bar.instrument,
    recentBars: [bar],
    indicators: emptyIndicators(),
    sessionContext: emptySession(),
    currentPositions: [],
    accountEquity: 100_000,
    now: bar.timestampUtc,
  };
}

/** Stub data feed yielding 14 identical daily bars so ATR(14) is well-defined. */
function stubDataFeed(dailyAtrPriceUnits: number): MarketDataFeed {
  const dayBars: Bar[] = [];
  const start = Date.parse("2024-12-15T00:00:00Z");
  // Each bar with true-range = `dailyAtrPriceUnits` after the first; ATR(14)
  // then equals that value after 14 bars.
  for (let i = 0; i < 30; i += 1) {
    const mid = 1.1 + i * 0;
    dayBars.push({
      instrument: "EURUSD",
      timeframe: "d1",
      timestampUtc: new Date(start + i * 86_400_000),
      open: mid,
      high: mid + dailyAtrPriceUnits / 2,
      low: mid - dailyAtrPriceUnits / 2,
      close: mid,
      volume: 100,
      source: "historical",
    });
  }
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async start() {},
    // eslint-disable-next-line @typescript-eslint/require-await
    async stop() {},
    isConnected: () => true,
    getCurrentBar: () => null,
    // eslint-disable-next-line @typescript-eslint/require-await
    async getHistoricalBars(_inst: string, tf: Timeframe) {
      return tf === "d1" ? dayBars : [];
    },
    // eslint-disable-next-line require-yield
    async *subscribe(): AsyncIterable<Bar> {
      return;
    },
  };
}

async function freshStrategy(dailyAtrPrice = 0.005): Promise<AsianRangeSweepStrategy> {
  const strat = new AsianRangeSweepStrategy("EURUSD");
  await strat.initialize({
    sessionId: randomUUID(),
    config: strat.config,
    mode: "backtest",
    initialEquityUsd: 100_000,
    dataFeed: stubDataFeed(dailyAtrPrice),
    clock: { now: () => new Date("2025-01-02T00:00:00Z"), sleep: async () => {} },
  });
  return strat;
}

describe("AsianRangeSweepStrategy", () => {
  it("requires dataFeed in StrategyContext", async () => {
    const strat = new AsianRangeSweepStrategy("EURUSD");
    await expect(
      strat.initialize({
        sessionId: "x",
        config: strat.config,
        mode: "backtest",
        initialEquityUsd: 100_000,
      }),
    ).rejects.toThrow(/dataFeed/u);
  });

  it("accumulates Asian range during 00:00-07:00 UTC", async () => {
    const strat = await freshStrategy();
    // Feed 120 bars across 00:00-02:00 UTC. They build asian range; no signal.
    let signals = 0;
    const dayStart = Date.parse("2025-01-02T00:00:00Z");
    for (let i = 0; i < 120; i += 1) {
      const ts = new Date(dayStart + i * 60_000);
      const bar = mkBar(ts.toISOString(), 1.1, 1.101, 1.099, 1.1);
      signals += (await strat.generateSignals(makeState(bar))).length;
    }
    expect(signals).toBe(0);
  });

  it("emits a long signal on a sweep-of-low + reversal in the London window", async () => {
    const strat = await freshStrategy(0.005); // daily ATR = 0.005
    const dayStart = Date.parse("2025-01-02T00:00:00Z");

    // Asian session 00:00-07:00 UTC: 420 M1 bars pinned at high=1.101,
    // low=1.099. So asianHigh=1.101, asianLow=1.099.
    for (let i = 0; i < 420; i += 1) {
      const ts = new Date(dayStart + i * 60_000);
      const bar = mkBar(ts.toISOString(), 1.1, 1.101, 1.099, 1.1);
      await strat.generateSignals(makeState(bar));
    }

    // 07:30 UTC sweep bar: low = 1.0975 -> depth = (1.099 - 1.0975) / 0.005
    // = 0.3, between 0.05 and 0.8 -> 'breached'.
    const sweepTs = new Date(dayStart + 450 * 60_000); // 07:30 UTC
    const sweepBar = mkBar(sweepTs.toISOString(), 1.0985, 1.0988, 1.0975, 1.098);
    let sigs = await strat.generateSignals(makeState(sweepBar));
    expect(sigs).toHaveLength(0); // breach recorded but no reversal yet

    // 07:31 UTC: bullish reversal candle whose close (1.0996) takes us
    // back above asianLow (1.099). Body 13 pips, range 16 pips ->
    // body/range = 0.8125 >= 0.5.
    const revTs = new Date(dayStart + 451 * 60_000);
    const revBar = mkBar(revTs.toISOString(), 1.0983, 1.0998, 1.0982, 1.0996);
    sigs = await strat.generateSignals(makeState(revBar));
    expect(sigs).toHaveLength(1);
    expect(sigs[0]?.direction).toBe("long");
    expect(sigs[0]?.proposedEntryPrice).toBeCloseTo(1.0996, 8);
    // Stop = sweep extreme (1.0975) - 1.5 pips buffer.
    expect(sigs[0]?.proposedStopPrice).toBeCloseTo(1.0975 - 1.5 * 0.0001, 6);
  });

  it("ignores too-shallow sweeps (depth < minSweepAtr)", async () => {
    const strat = await freshStrategy(0.005);
    const dayStart = Date.parse("2025-01-02T00:00:00Z");
    // Build Asian range as before.
    for (let i = 0; i < 420; i += 1) {
      const ts = new Date(dayStart + i * 60_000);
      const bar = mkBar(
        ts.toISOString(),
        1.1,
        Math.min(1.102, 1.1005),
        Math.max(1.098, 1.0995),
        1.1,
      );
      await strat.generateSignals(makeState(bar));
    }
    // Sweep by only 1 pip: depth = 0.0001 / 0.005 = 0.02 < 0.05 -> skip.
    const sweepTs = new Date(dayStart + 450 * 60_000);
    const sweepBar = mkBar(sweepTs.toISOString(), 1.098, 1.0982, 1.0979, 1.098);
    const sigs = await strat.generateSignals(makeState(sweepBar));
    expect(sigs).toHaveLength(0);

    // Even with a reversal candle on the next bar, no signal should emit
    // because the sweep itself never registered.
    const revTs = new Date(dayStart + 451 * 60_000);
    const revBar = mkBar(revTs.toISOString(), 1.0979, 1.099, 1.0979, 1.0989);
    const sigs2 = await strat.generateSignals(makeState(revBar));
    expect(sigs2).toHaveLength(0);
  });

  it("abandons too-deep sweeps (depth > maxSweepAtr)", async () => {
    const strat = await freshStrategy(0.005);
    const dayStart = Date.parse("2025-01-02T00:00:00Z");
    for (let i = 0; i < 420; i += 1) {
      const ts = new Date(dayStart + i * 60_000);
      const bar = mkBar(ts.toISOString(), 1.1, 1.1005, 1.0995, 1.1);
      await strat.generateSignals(makeState(bar));
    }
    // Sweep depth = (1.098 - 1.094) / 0.005 = 0.8 — exactly at maxSweepAtr;
    // anything deeper marks abandoned.
    const sweepTs = new Date(dayStart + 450 * 60_000);
    const sweepBar = mkBar(sweepTs.toISOString(), 1.098, 1.098, 1.093, 1.094);
    const sigs = await strat.generateSignals(makeState(sweepBar));
    expect(sigs).toHaveLength(0);

    // Subsequent bullish reversal must NOT emit (state is abandoned).
    const revTs = new Date(dayStart + 451 * 60_000);
    const revBar = mkBar(revTs.toISOString(), 1.094, 1.099, 1.094, 1.098);
    const sigs2 = await strat.generateSignals(makeState(revBar));
    expect(sigs2).toHaveLength(0);
  });

  it("resets per-day state at UTC midnight", async () => {
    const strat = await freshStrategy(0.005);
    // Day 1: accumulate range.
    const d1 = Date.parse("2025-01-02T00:00:00Z");
    for (let i = 0; i < 60; i += 1) {
      const ts = new Date(d1 + i * 60_000);
      await strat.generateSignals(
        makeState(mkBar(ts.toISOString(), 1.1, 1.101, 1.099, 1.1)),
      );
    }
    // Cross midnight (day 2 06:30 UTC).
    const d2 = Date.parse("2025-01-03T06:30:00Z");
    const bar = mkBar(new Date(d2).toISOString(), 1.05, 1.051, 1.049, 1.05);
    const sigs = await strat.generateSignals(makeState(bar));
    // No signal — but more importantly, no error from carried-over state.
    expect(sigs).toHaveLength(0);
  });
});
