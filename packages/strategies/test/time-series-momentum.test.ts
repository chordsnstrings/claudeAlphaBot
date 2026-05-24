import {
  type Bar,
  type IndicatorSnapshot,
  type MarketState,
  type Position,
  type SessionContext,
} from "@trading/core";
import { describe, expect, it } from "vitest";

import { TimeSeriesMomentumStrategy } from "../src/time-series-momentum.js";

function emptyIndicators(atr14: number | null): IndicatorSnapshot {
  return {
    atr14,
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

/** Build a recentBars series whose last bar's close gives the desired
 * trailing return over `lookback` bars. */
function seriesWithReturn(lookback: number, ret: number, lastClose = 1.1): Bar[] {
  const firstClose = lastClose / (1 + ret);
  const bars: Bar[] = [];
  const n = lookback + 2;
  for (let i = 0; i < n; i += 1) {
    // Linear interpolation from firstClose (at index n-1-lookback) to lastClose.
    // Index of the "past" reference is (n-1) - lookback.
    const close =
      i <= n - 1 - lookback
        ? firstClose
        : firstClose + ((lastClose - firstClose) * (i - (n - 1 - lookback))) / lookback;
    bars.push({
      instrument: "EURUSD",
      timeframe: "d1",
      timestampUtc: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000),
      open: close,
      high: close,
      low: close,
      close,
      volume: 0,
      source: "historical",
    });
  }
  return bars;
}

function state(bars: Bar[], atr14: number): MarketState {
  const last = bars[bars.length - 1] as Bar;
  return {
    currentBar: last,
    instrument: "EURUSD",
    recentBars: bars,
    indicators: emptyIndicators(atr14),
    sessionContext: emptySession(),
    currentPositions: [],
    accountEquity: 100_000,
    now: last.timestampUtc,
  };
}

function fakePosition(direction: "long" | "short", id = "p1"): Position {
  return {
    id,
    sessionId: "s",
    originatingSignalId: "sig",
    originatingStrategy: "tsmom",
    instrument: "EURUSD",
    direction,
    entryPrice: 1.1,
    entryTime: new Date(),
    currentStopPrice: direction === "long" ? 1.0 : 1.2,
    currentTargetPrice: direction === "long" ? 2.0 : 0.2,
    lotSize: 1,
    notionalUsd: 110_000,
    initialRiskPct: 1.5,
    initialRiskUsd: 1500,
    frictionPaidUsd: { spread: 0, slippage: 0, commission: 0, swap: 0 },
    unrealizedPnLUsd: 0,
    unrealizedPnLPct: 0,
    brokerOrderId: null,
    brokerPositionId: id,
  };
}

describe("TimeSeriesMomentumStrategy", () => {
  it("goes long when the trailing return is positive", async () => {
    const s = new TimeSeriesMomentumStrategy("EURUSD", { lookbackBars: 60 });
    const sigs = await s.generateSignals(state(seriesWithReturn(60, 0.05), 0.005));
    expect(sigs).toHaveLength(1);
    expect(sigs[0]?.direction).toBe("long");
    // Wide disaster stop: 20 x ATR below entry.
    expect(sigs[0]?.proposedStopPrice).toBeCloseTo(1.1 - 20 * 0.005, 6);
  });

  it("goes short when the trailing return is negative", async () => {
    const s = new TimeSeriesMomentumStrategy("EURUSD", { lookbackBars: 60 });
    const sigs = await s.generateSignals(state(seriesWithReturn(60, -0.05), 0.005));
    expect(sigs[0]?.direction).toBe("short");
  });

  it("emits no signal until the lookback window is full", async () => {
    const s = new TimeSeriesMomentumStrategy("EURUSD", { lookbackBars: 252 });
    const sigs = await s.generateSignals(state(seriesWithReturn(60, 0.05), 0.005));
    expect(sigs).toHaveLength(0); // only 62 bars < 253 needed
  });

  it("respects minAbsReturn filter", async () => {
    const s = new TimeSeriesMomentumStrategy("EURUSD", {
      lookbackBars: 60,
      minAbsReturn: 0.1,
    });
    // 5% return < 10% threshold -> no trade
    expect(await s.generateSignals(state(seriesWithReturn(60, 0.05), 0.005))).toHaveLength(0);
  });

  it("exitsForBar requests a close when the trend flips against a long", async () => {
    const s = new TimeSeriesMomentumStrategy("EURUSD", { lookbackBars: 60 });
    // Open a long via a position event.
    await s.onPositionEvent({ type: "opened", position: fakePosition("long") });
    // Now the trailing return is negative -> flip -> exit.
    const exits = s.exitsForBar(state(seriesWithReturn(60, -0.05), 0.005));
    expect(exits).toHaveLength(1);
    expect(exits[0]?.positionId).toBe("p1");
    expect(exits[0]?.reason).toBe("signal_flip");
  });

  it("exitsForBar holds a long while the trend stays positive", async () => {
    const s = new TimeSeriesMomentumStrategy("EURUSD", { lookbackBars: 60 });
    await s.onPositionEvent({ type: "opened", position: fakePosition("long") });
    const exits = s.exitsForBar(state(seriesWithReturn(60, 0.05), 0.005));
    expect(exits).toHaveLength(0);
  });

  it("does not re-enter while already positioned", async () => {
    const s = new TimeSeriesMomentumStrategy("EURUSD", { lookbackBars: 60 });
    await s.onPositionEvent({ type: "opened", position: fakePosition("long") });
    const sigs = await s.generateSignals(state(seriesWithReturn(60, 0.05), 0.005));
    expect(sigs).toHaveLength(0);
  });
});
