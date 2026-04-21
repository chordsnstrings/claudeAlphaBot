import { describe, expect, it } from "vitest";

import type { Candle, FundingRate } from "@hydra/shared";

import { evaluateFundingFade } from "../../src/core/signals-funding-fade.js";

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

const SETTLEMENT = Date.UTC(2024, 9, 20, 16, 0, 0); // Sun Oct 20 2024 16:00 UTC
const NOW = SETTLEMENT + 30 * MIN_MS; // confirmation evaluation moment

function bar(openTime: number, p: { open?: number; close: number; high?: number; low?: number }): Candle {
  return {
    symbol: "BTCUSDT",
    openTime,
    closeTime: openTime + HOUR_MS - 1,
    open: p.open ?? p.close,
    high: p.high ?? p.close,
    low: p.low ?? p.close,
    close: p.close,
    volume: 1,
  };
}

function makeFunding(rate: number): FundingRate[] {
  return [{ symbol: "BTCUSDT", fundingTime: SETTLEMENT, fundingRate: rate }];
}

describe("evaluateFundingFade — positive (spec §5.5)", () => {
  it("fires SHORT when +0.08% funding + price drop −0.22% confirms", () => {
    const candles: Candle[] = [
      // Settlement-hour candle: openTime = 16:00, open = 67_800
      bar(SETTLEMENT, { open: 67_800, close: 67_750, high: 67_810, low: 67_700 }),
    ];
    const r = evaluateFundingFade({
      symbol: "BTCUSDT",
      candles,
      confirmationPriceOverride: 67_650,
      fundingHistory: makeFunding(0.0008),
      nowUtc: NOW,
      accountEquity: 5_000,
      tradesToday: 0,
      hasExistingPosition: false,
    });
    expect(r.type).toBe("FIRE");
    if (r.type !== "FIRE") return;
    expect(r.signal.strategy).toBe("FUNDING_FADE");
    expect(r.signal.direction).toBe("SHORT");
    expect(r.signal.entryPrice).toBe(67_650);
    expect(r.signal.stopPrice).toBeCloseTo(67_650 * 1.008, 4);
    expect(r.signal.tp1Price).toBeCloseTo(67_650 * 0.985, 4);
    expect(r.signal.tp1Price).toBe(r.signal.tp2Price); // single target
    expect(r.signal.tp1AllocationPct).toBe(100);
    expect(r.signal.timeStopUtc).toBe(SETTLEMENT + 8 * HOUR_MS);
  });

  it("fires LONG when negative funding and price rises +0.25%", () => {
    const candles: Candle[] = [
      bar(SETTLEMENT, { open: 67_800, close: 67_810 }),
    ];
    const r = evaluateFundingFade({
      symbol: "BTCUSDT",
      candles,
      confirmationPriceOverride: 67_800 * 1.0025,
      fundingHistory: makeFunding(-0.0008),
      nowUtc: NOW,
      accountEquity: 5_000,
      tradesToday: 0,
      hasExistingPosition: false,
    });
    expect(r.type).toBe("FIRE");
    if (r.type !== "FIRE") return;
    expect(r.signal.direction).toBe("LONG");
    expect(r.signal.stopPrice).toBeCloseTo(r.signal.entryPrice * 0.992, 6);
  });
});

describe("evaluateFundingFade — negative", () => {
  it("SKIP EQUITY_TOO_LOW when account < $3,000", () => {
    const r = evaluateFundingFade({
      symbol: "BTCUSDT",
      candles: [bar(SETTLEMENT, { open: 67_800, close: 67_750 })],
      confirmationPriceOverride: 67_650,
      fundingHistory: makeFunding(0.0008),
      nowUtc: NOW,
      accountEquity: 2_999.99,
      tradesToday: 0,
      hasExistingPosition: false,
    });
    expect(r.type).toBe("SKIP");
    if (r.type === "SKIP") expect(r.reason).toBe("EQUITY_TOO_LOW");
  });

  it("SKIP MAX_DAILY_TRADES when 3 trades already today", () => {
    const r = evaluateFundingFade({
      symbol: "BTCUSDT",
      candles: [bar(SETTLEMENT, { open: 67_800, close: 67_750 })],
      confirmationPriceOverride: 67_650,
      fundingHistory: makeFunding(0.0008),
      nowUtc: NOW,
      accountEquity: 5_000,
      tradesToday: 3,
      hasExistingPosition: false,
    });
    expect(r.type).toBe("SKIP");
    if (r.type === "SKIP") expect(r.reason).toBe("MAX_DAILY_TRADES");
  });

  it("SKIP FUNDING_TOO_SMALL when |rate| < 0.0005", () => {
    const r = evaluateFundingFade({
      symbol: "BTCUSDT",
      candles: [bar(SETTLEMENT, { open: 67_800, close: 67_750 })],
      confirmationPriceOverride: 67_650,
      fundingHistory: makeFunding(0.0003),
      nowUtc: NOW,
      accountEquity: 5_000,
      tradesToday: 0,
      hasExistingPosition: false,
    });
    expect(r.type).toBe("SKIP");
    if (r.type === "SKIP") expect(r.reason).toBe("FUNDING_TOO_SMALL");
  });

  it("SKIP CONFIRMATION_INSUFFICIENT when SHORT setup but price barely moved", () => {
    const r = evaluateFundingFade({
      symbol: "BTCUSDT",
      candles: [bar(SETTLEMENT, { open: 67_800, close: 67_790 })],
      confirmationPriceOverride: 67_790, // only −0.015%
      fundingHistory: makeFunding(0.0008),
      nowUtc: NOW,
      accountEquity: 5_000,
      tradesToday: 0,
      hasExistingPosition: false,
    });
    expect(r.type).toBe("SKIP");
    if (r.type === "SKIP") expect(r.reason).toBe("CONFIRMATION_INSUFFICIENT");
  });

  it("SKIP NO_RECENT_SETTLEMENT when funding was >8h ago", () => {
    const stale: FundingRate[] = [
      { symbol: "BTCUSDT", fundingTime: NOW - 9 * HOUR_MS, fundingRate: 0.001 },
    ];
    const r = evaluateFundingFade({
      symbol: "BTCUSDT",
      candles: [bar(NOW - 9 * HOUR_MS, { open: 67_800, close: 67_750 })],
      confirmationPriceOverride: 67_650,
      fundingHistory: stale,
      nowUtc: NOW,
      accountEquity: 5_000,
      tradesToday: 0,
      hasExistingPosition: false,
    });
    expect(r.type).toBe("SKIP");
    if (r.type === "SKIP") expect(r.reason).toBe("NO_RECENT_SETTLEMENT");
  });

  it("SKIP EXISTING_POSITION", () => {
    const r = evaluateFundingFade({
      symbol: "BTCUSDT",
      candles: [bar(SETTLEMENT, { open: 67_800, close: 67_750 })],
      confirmationPriceOverride: 67_650,
      fundingHistory: makeFunding(0.0008),
      nowUtc: NOW,
      accountEquity: 5_000,
      tradesToday: 0,
      hasExistingPosition: true,
    });
    expect(r.type).toBe("SKIP");
    if (r.type === "SKIP") expect(r.reason).toBe("EXISTING_POSITION");
  });
});
