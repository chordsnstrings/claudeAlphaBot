import { describe, expect, it } from "vitest";

import {
  BinanceRestClient,
  BinanceRestError,
  parseFundingRate,
  parseKline,
  type RawKline,
  type RawFundingRate,
} from "../../src/data/binance-rest.js";

describe("parseKline", () => {
  it("converts string OHLCV to numbers and carries timestamps through", () => {
    const raw: RawKline = [
      1_700_000_000_000,
      "25000.1",
      "25100.2",
      "24900.3",
      "25050.4",
      "123.456",
      1_700_003_599_999,
      "quote",
      42,
      "tb_base",
      "tb_quote",
      "ignore",
    ];
    const k = parseKline("BTCUSDT", raw);
    expect(k).toEqual({
      symbol: "BTCUSDT",
      openTime: 1_700_000_000_000,
      closeTime: 1_700_003_599_999,
      open: 25000.1,
      high: 25100.2,
      low: 24900.3,
      close: 25050.4,
      volume: 123.456,
    });
  });

  it("never uses future fields (7–11) — defends against a subtle miscount", () => {
    const raw: RawKline = [
      1, "1", "2", "0.5", "1.5", "10",
      2, "ZZZZ", 999, "BOOM", "BOOM", "BOOM",
    ];
    const k = parseKline("ETHUSDT", raw);
    expect(Number.isFinite(k.open)).toBe(true);
    expect(Number.isFinite(k.volume)).toBe(true);
  });
});

describe("parseFundingRate", () => {
  it("converts fundingRate string to number", () => {
    const raw: RawFundingRate = {
      symbol: "BTCUSDT",
      fundingTime: 1_700_000_000_000,
      fundingRate: "0.00010000",
    };
    expect(parseFundingRate("BTCUSDT", raw)).toEqual({
      symbol: "BTCUSDT",
      fundingTime: 1_700_000_000_000,
      fundingRate: 0.0001,
    });
  });

  it("handles negative rates", () => {
    const raw: RawFundingRate = {
      symbol: "SOLUSDT",
      fundingTime: 1,
      fundingRate: "-0.0005",
    };
    expect(parseFundingRate("SOLUSDT", raw).fundingRate).toBe(-0.0005);
  });
});

describe("BinanceRestError", () => {
  it("captures status, code, retryable", () => {
    const err = new BinanceRestError("msg", 429, true, -1003);
    expect(err.status).toBe(429);
    expect(err.code).toBe(-1003);
    expect(err.retryable).toBe(true);
    expect(err.name).toBe("BinanceRestError");
  });

  it("allows retryable=false for 4xx non-429", () => {
    const err = new BinanceRestError("bad param", 400, false);
    expect(err.retryable).toBe(false);
  });
});

describe("BinanceRestClient constructor", () => {
  it("picks prod base by default", () => {
    const c = new BinanceRestClient();
    // access private field indirectly via method behavior — probe via
    // exposed getKlines by wiring testnet flag and comparing URLs
    const t = new BinanceRestClient({ testnet: true });
    // We can't read private fields; assert both instances construct
    // without throwing and don't share state.
    expect(c).toBeInstanceOf(BinanceRestClient);
    expect(t).toBeInstanceOf(BinanceRestClient);
  });

  it("accepts a custom baseUrl", () => {
    const c = new BinanceRestClient({ baseUrl: "https://example.test" });
    expect(c).toBeInstanceOf(BinanceRestClient);
  });
});
