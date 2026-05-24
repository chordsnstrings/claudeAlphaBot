import { describe, expect, it } from "vitest";

import { buildCarryBars, parseFundingCsv } from "../src/ingestion/funding.js";

describe("funding ingestion", () => {
  it("parses date,asset,funding_rate (order-insensitive, alt header names)", () => {
    const csv = [
      "asset,date,funding",
      "btc,2024-01-01,0.0003",
      "btc,2024-01-02,-0.0001",
      "eth,2024-01-01,0.0005",
      "", // blank line ignored
    ].join("\n");
    const rows = parseFundingCsv(csv);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ date: "2024-01-01", asset: "btc", fundingRate: 0.0003 });
    expect(rows[1]?.fundingRate).toBe(-0.0001);
  });

  it("throws when required columns are missing", () => {
    expect(() => parseFundingCsv("foo,bar\n1,2")).toThrow(/must have columns/);
  });

  it("compounds the synthetic carry price by the daily funding rate", () => {
    const rows = [
      { date: "2024-01-02", asset: "btc", fundingRate: 0.01 },
      { date: "2024-01-01", asset: "btc", fundingRate: 0.02 }, // out of order on purpose
    ];
    const bars = buildCarryBars("BTCCARRY", rows, 100);
    // Sorted ascending by date, compounding from base 100.
    expect(bars).toHaveLength(2);
    expect(bars[0]?.timestampUtc.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(Number(bars[0]?.close)).toBeCloseTo(102, 6); // 100 * 1.02
    expect(Number(bars[1]?.close)).toBeCloseTo(103.02, 6); // 102 * 1.01
    // O=H=L=C (close-only synthetic series).
    expect(bars[1]?.open).toBe(bars[1]?.close);
    expect(bars[1]?.high).toBe(bars[1]?.low);
  });

  it("negative funding decays the carry price (you pay)", () => {
    const bars = buildCarryBars("BTCCARRY", [
      { date: "2024-01-01", asset: "btc", fundingRate: -0.05 },
    ], 100);
    expect(Number(bars[0]?.close)).toBeCloseTo(95, 6);
  });
});
