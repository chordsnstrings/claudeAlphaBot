import { describe, expect, it } from "vitest";

import type {
  Candle,
  FundingRate,
  OpenPosition,
  SignalIntent,
  StrategyName,
  Symbol as TradingSymbol,
} from "@hydra/shared";

import {
  checkCorrelationCap,
  checkFundingPenalty,
  checkHtfBias,
  checkOiSpike,
  checkVolSpike,
  evaluateVetos,
} from "../../src/core/veto.js";

const HOUR_MS = 3_600_000;
const NOW = Date.UTC(2024, 9, 14, 12, 0, 0);

function makeIntent(p: {
  strategy?: StrategyName;
  symbol?: TradingSymbol;
  direction?: "LONG" | "SHORT";
}): SignalIntent {
  return {
    strategy: p.strategy ?? "WEEKEND_MR",
    symbol: p.symbol ?? "BTCUSDT",
    direction: p.direction ?? "SHORT",
    generatedAt: NOW,
    entryPrice: 65_000,
    stopPrice: 65_650,
    tp1Price: 64_350,
    tp2Price: 64_000,
    tp1AllocationPct: 70,
    breakevenTriggerPrice: 64_350,
    timeStopUtc: NOW + 32 * HOUR_MS,
    reasoning: "test",
  };
}

function makeCandles(close: number, n: number, slopePerBar = 0): Candle[] {
  const cs: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const c = close + slopePerBar * i;
    cs.push({
      symbol: "BTCUSDT",
      openTime: NOW - (n - i) * 4 * HOUR_MS,
      closeTime: NOW - (n - i) * 4 * HOUR_MS + 4 * HOUR_MS - 1,
      open: c,
      high: c + 5,
      low: c - 5,
      close: c,
      volume: 1,
    });
  }
  return cs;
}

function makeOpen(p: {
  symbol: TradingSymbol;
  strategy?: StrategyName;
}): OpenPosition {
  return {
    id: `pos-${p.symbol}`,
    mode: "backtest",
    strategy: p.strategy ?? "ARB",
    symbol: p.symbol,
    direction: "LONG",
    entryTime: NOW - HOUR_MS,
    entryPrice: 100,
    quantity: 1,
    remainingQuantity: 1,
    notionalUsd: 100,
    stopPrice: 99,
    tp1Price: 102,
    tp2Price: 105,
    breakevenTriggerPrice: 102,
    timeStopUtc: NOW + 8 * HOUR_MS,
    tp1Filled: false,
    breakevenMoved: false,
    feesPaidUsd: 0,
    realizedPnlUsd: 0,
  };
}

describe("veto.checkVolSpike", () => {
  it("VETO when prior 1H bar moved > 10%", () => {
    const recent: Candle[] = [
      // last bar: 11% range
      {
        symbol: "BTCUSDT",
        openTime: NOW - HOUR_MS,
        closeTime: NOW - 1,
        open: 100,
        high: 111,
        low: 100,
        close: 110,
        volume: 1,
      },
    ];
    const r = checkVolSpike({
      intent: makeIntent({}),
      openPositions: [],
      recentCandles: recent,
      nowUtc: NOW,
    });
    expect(r.type).toBe("VETO");
    if (r.type === "VETO") expect(r.reason).toBe("VOL_SPIKE_PAUSE");
  });

  it("PASS when range below threshold", () => {
    const recent: Candle[] = [
      {
        symbol: "BTCUSDT",
        openTime: NOW - HOUR_MS,
        closeTime: NOW - 1,
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 1,
      },
    ];
    const r = checkVolSpike({
      intent: makeIntent({}),
      openPositions: [],
      recentCandles: recent,
      nowUtc: NOW,
    });
    expect(r.type).toBe("PASS");
  });
});

describe("veto.checkOiSpike", () => {
  it("VETO when OI jumps > 10% in last hour", () => {
    const oiSeries = [
      { t: NOW - 2 * HOUR_MS, oi: 1_000_000 },
      { t: NOW, oi: 1_120_000 }, // +12%
    ];
    const r = checkOiSpike({
      intent: makeIntent({}),
      openPositions: [],
      recentCandles: [],
      openInterestSeries: oiSeries,
      nowUtc: NOW,
    });
    expect(r.type).toBe("VETO");
    if (r.type === "VETO") expect(r.reason).toBe("OI_SPIKE");
  });

  it("PASS when OI change small", () => {
    const oiSeries = [
      { t: NOW - 2 * HOUR_MS, oi: 1_000_000 },
      { t: NOW, oi: 1_050_000 },
    ];
    const r = checkOiSpike({
      intent: makeIntent({}),
      openPositions: [],
      recentCandles: [],
      openInterestSeries: oiSeries,
      nowUtc: NOW,
    });
    expect(r.type).toBe("PASS");
  });

  it("PASS when no OI series provided", () => {
    const r = checkOiSpike({
      intent: makeIntent({}),
      openPositions: [],
      recentCandles: [],
      nowUtc: NOW,
    });
    expect(r.type).toBe("PASS");
  });
});

describe("veto.checkCorrelationCap", () => {
  it("VETO when 2 majors already open", () => {
    const r = checkCorrelationCap({
      intent: makeIntent({ symbol: "SOLUSDT" }),
      openPositions: [makeOpen({ symbol: "BTCUSDT" }), makeOpen({ symbol: "ETHUSDT" })],
      recentCandles: [],
      nowUtc: NOW,
    });
    expect(r.type).toBe("VETO");
    if (r.type === "VETO") expect(r.reason).toBe("CORRELATION_CAP");
  });

  it("PASS when 1 major open", () => {
    const r = checkCorrelationCap({
      intent: makeIntent({ symbol: "ETHUSDT" }),
      openPositions: [makeOpen({ symbol: "BTCUSDT" })],
      recentCandles: [],
      nowUtc: NOW,
    });
    expect(r.type).toBe("PASS");
  });
});

describe("veto.checkHtfBias", () => {
  it("VETO MR SHORT when HTF trending up", () => {
    const htf = makeCandles(60_000, 80, 50); // strong upslope
    const r = checkHtfBias({
      intent: makeIntent({ strategy: "WEEKEND_MR", direction: "SHORT" }),
      htfCandles: htf,
      openPositions: [],
      recentCandles: [],
      nowUtc: NOW,
    });
    expect(r.type).toBe("VETO");
    if (r.type === "VETO") expect(r.reason).toBe("HTF_BIAS_AGAINST");
  });

  it("VETO MR LONG when HTF trending down (lower-band walking)", () => {
    const htf = makeCandles(80_000, 80, -50);
    const r = checkHtfBias({
      intent: makeIntent({ strategy: "BB_MR", direction: "LONG" }),
      htfCandles: htf,
      openPositions: [],
      recentCandles: [],
      nowUtc: NOW,
    });
    expect(r.type).toBe("VETO");
    if (r.type === "VETO") expect(r.reason).toBe("HTF_BIAS_AGAINST");
  });

  it("PASS for non-MR strategies (ARB, NY_OPEN)", () => {
    const htf = makeCandles(60_000, 80, 50);
    const r = checkHtfBias({
      intent: makeIntent({ strategy: "ARB", direction: "SHORT" }),
      htfCandles: htf,
      openPositions: [],
      recentCandles: [],
      nowUtc: NOW,
    });
    expect(r.type).toBe("PASS");
  });

  it("PASS when HTF candles missing or too short", () => {
    const r = checkHtfBias({
      intent: makeIntent({ strategy: "WEEKEND_MR", direction: "SHORT" }),
      htfCandles: makeCandles(60_000, 5),
      openPositions: [],
      recentCandles: [],
      nowUtc: NOW,
    });
    expect(r.type).toBe("PASS");
  });

  it("PASS MR SHORT when HTF trending DOWN (favorable)", () => {
    const htf = makeCandles(80_000, 80, -50);
    const r = checkHtfBias({
      intent: makeIntent({ strategy: "WEEKEND_MR", direction: "SHORT" }),
      htfCandles: htf,
      openPositions: [],
      recentCandles: [],
      nowUtc: NOW,
    });
    expect(r.type).toBe("PASS");
  });
});

describe("veto.checkFundingPenalty", () => {
  it("SCALE leverage by 0.5 when LONG would PAY positive funding", () => {
    const f: FundingRate = {
      symbol: "BTCUSDT",
      fundingTime: NOW - 30 * 60_000,
      fundingRate: 0.001,
    };
    const r = checkFundingPenalty({
      intent: makeIntent({ strategy: "ARB", direction: "LONG" }),
      currentFunding: f,
      openPositions: [],
      recentCandles: [],
      nowUtc: NOW,
    });
    expect(r.type).toBe("SCALE");
    if (r.type === "SCALE") {
      expect(r.notionalMultiplier).toBe(0.5);
      expect(r.reason).toBe("FUNDING_PENALTY");
    }
  });

  it("PASS when SHORT receives positive funding (favorable)", () => {
    const f: FundingRate = {
      symbol: "BTCUSDT",
      fundingTime: NOW - 30 * 60_000,
      fundingRate: 0.001,
    };
    const r = checkFundingPenalty({
      intent: makeIntent({ strategy: "ARB", direction: "SHORT" }),
      currentFunding: f,
      openPositions: [],
      recentCandles: [],
      nowUtc: NOW,
    });
    expect(r.type).toBe("PASS");
  });

  it("PASS when funding below elevated threshold", () => {
    const f: FundingRate = {
      symbol: "BTCUSDT",
      fundingTime: NOW - 30 * 60_000,
      fundingRate: 0.0001,
    };
    const r = checkFundingPenalty({
      intent: makeIntent({ strategy: "ARB", direction: "LONG" }),
      currentFunding: f,
      openPositions: [],
      recentCandles: [],
      nowUtc: NOW,
    });
    expect(r.type).toBe("PASS");
  });

  it("PASS for FUNDING_FADE strategy (exempt)", () => {
    const f: FundingRate = {
      symbol: "BTCUSDT",
      fundingTime: NOW - 30 * 60_000,
      fundingRate: 0.001,
    };
    const r = checkFundingPenalty({
      intent: makeIntent({ strategy: "FUNDING_FADE", direction: "LONG" }),
      currentFunding: f,
      openPositions: [],
      recentCandles: [],
      nowUtc: NOW,
    });
    expect(r.type).toBe("PASS");
  });
});

describe("evaluateVetos — composition", () => {
  it("returns PASS when all checks pass", () => {
    const r = evaluateVetos({
      intent: makeIntent({ strategy: "ARB", direction: "LONG" }),
      openPositions: [],
      recentCandles: [],
      nowUtc: NOW,
    });
    expect(r.type).toBe("PASS");
  });

  it("BLOCK takes precedence over SCALE", () => {
    // OI spike + funding penalty: BLOCK should win
    const r = evaluateVetos({
      intent: makeIntent({ strategy: "ARB", direction: "LONG" }),
      openPositions: [],
      recentCandles: [],
      currentFunding: { symbol: "BTCUSDT", fundingTime: NOW - 60_000, fundingRate: 0.001 },
      openInterestSeries: [
        { t: NOW - 2 * HOUR_MS, oi: 1_000_000 },
        { t: NOW, oi: 1_120_000 },
      ],
      nowUtc: NOW,
    });
    expect(r.type).toBe("VETO");
    if (r.type === "VETO") expect(r.reason).toBe("OI_SPIKE");
  });

  it("returns SCALE when only funding penalty applies", () => {
    const r = evaluateVetos({
      intent: makeIntent({ strategy: "ARB", direction: "LONG" }),
      openPositions: [],
      recentCandles: [],
      currentFunding: { symbol: "BTCUSDT", fundingTime: NOW - 60_000, fundingRate: 0.001 },
      nowUtc: NOW,
    });
    expect(r.type).toBe("SCALE");
    if (r.type === "SCALE") expect(r.notionalMultiplier).toBe(0.5);
  });
});
