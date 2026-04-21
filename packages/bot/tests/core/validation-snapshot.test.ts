import { describe, expect, it } from "vitest";

import type { Candle, Symbol as TradingSymbol } from "@hydra/shared";

import {
  captureValidationSnapshot,
  realizedVolatilityAnnualized,
} from "../../src/core/validation-snapshot.js";

const HOUR_MS = 3_600_000;

function buildSeries(symbol: TradingSymbol, n: number, base: number): Candle[] {
  const cs: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const close = base + Math.sin(i / 5) * (base * 0.01);
    cs.push({
      symbol,
      openTime: i * HOUR_MS,
      closeTime: (i + 1) * HOUR_MS - 1,
      open: close,
      high: close * 1.005,
      low: close * 0.995,
      close,
      volume: 1,
    });
  }
  return cs;
}

describe("captureValidationSnapshot", () => {
  it("captures one snapshot row per supported symbol", () => {
    const candlesBySymbol = new Map<TradingSymbol, readonly Candle[]>([
      ["BTCUSDT", buildSeries("BTCUSDT", 800, 65_000)],
      ["ETHUSDT", buildSeries("ETHUSDT", 800, 2_600)],
      ["SOLUSDT", buildSeries("SOLUSDT", 800, 150)],
    ]);
    const snap = captureValidationSnapshot({
      artifactHash: "abc123",
      candlesBySymbol,
      nowUtc: 999,
    });
    expect(snap.artifactHash).toBe("abc123");
    expect(snap.createdAtUtc).toBe(999);
    expect(snap.perSymbol.length).toBe(3);
    expect(snap.perSymbol.map((s) => s.symbol).sort()).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
    expect(Number.isFinite(snap.btcRealizedVol30d)).toBe(true);
  });

  it("emits placeholder snapshot for symbol with empty candles", () => {
    const candlesBySymbol = new Map<TradingSymbol, readonly Candle[]>([
      ["BTCUSDT", buildSeries("BTCUSDT", 800, 65_000)],
      ["ETHUSDT", []],
      ["SOLUSDT", buildSeries("SOLUSDT", 800, 150)],
    ]);
    const snap = captureValidationSnapshot({
      artifactHash: "abc",
      candlesBySymbol,
      nowUtc: 1,
    });
    const eth = snap.perSymbol.find((s) => s.symbol === "ETHUSDT");
    expect(eth?.regime).toBe("RANGING");
    expect(Number.isNaN(eth?.bbWidthPercentile)).toBe(true);
  });

  it("includes notes when provided", () => {
    const snap = captureValidationSnapshot({
      artifactHash: "x",
      candlesBySymbol: new Map(),
      nowUtc: 1,
      notes: "test snapshot",
    });
    expect(snap.notes).toBe("test snapshot");
  });
});

describe("realizedVolatilityAnnualized", () => {
  it("returns NaN with insufficient data", () => {
    expect(Number.isNaN(realizedVolatilityAnnualized([], 720))).toBe(true);
  });

  it("returns finite positive number for noisy series", () => {
    const cs = buildSeries("BTCUSDT", 800, 65_000);
    const v = realizedVolatilityAnnualized(cs, 720);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(0);
  });

  it("higher variance series → higher annualized vol", () => {
    const calm: Candle[] = [];
    const wild: Candle[] = [];
    for (let i = 0; i < 800; i++) {
      const c1 = 100 + Math.sin(i / 5) * 0.5;
      const c2 = 100 + Math.sin(i / 5) * 5;
      calm.push({ symbol: "BTCUSDT", openTime: i * HOUR_MS, closeTime: (i + 1) * HOUR_MS - 1, open: c1, high: c1, low: c1, close: c1, volume: 1 });
      wild.push({ symbol: "BTCUSDT", openTime: i * HOUR_MS, closeTime: (i + 1) * HOUR_MS - 1, open: c2, high: c2, low: c2, close: c2, volume: 1 });
    }
    const v1 = realizedVolatilityAnnualized(calm, 720);
    const v2 = realizedVolatilityAnnualized(wild, 720);
    expect(v2).toBeGreaterThan(v1);
  });
});
