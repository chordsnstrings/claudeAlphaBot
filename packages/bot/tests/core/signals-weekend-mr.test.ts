import { describe, expect, it } from "vitest";

import type { Candle } from "@hydra/shared";

import { evaluateWeekendMr } from "../../src/core/signals-weekend-mr.js";

const HOUR_MS = 3_600_000;

function bar(openTime: number, p: { high?: number; low?: number; close: number; open?: number; volume?: number }): Candle {
  return {
    symbol: "ETHUSDT",
    openTime,
    closeTime: openTime + HOUR_MS - 1,
    open: p.open ?? p.close,
    high: p.high ?? p.close,
    low: p.low ?? p.close,
    close: p.close,
    volume: p.volume ?? 1,
  };
}

/**
 * Build a Friday-23:00 → Monday-00:00 fixture.
 *   - Friday Oct 11 2024 23:00 UTC candle (close = friday_close)
 *   - Saturday + Sunday hourly candles with controlled high/low and final close
 *   - Monday 00:00 UTC candle (the candidate entry candle)
 */
function buildScenario(opts: {
  fridayClose: number;
  weekendHigh: number;
  weekendLow: number;
  sundayClose: number;
  mondayOpen: number;
}): Candle[] {
  const monday = Date.UTC(2024, 9, 14, 0, 0, 0); // Mon Oct 14, 2024
  const fridayLast = monday - 25 * HOUR_MS; // Fri Oct 11, 23:00 UTC
  const cs: Candle[] = [];
  cs.push(bar(fridayLast, { close: opts.fridayClose }));
  // 48 weekend hourly bars (Sat 00:00 → Sun 23:00 UTC)
  for (let i = 0; i < 48; i++) {
    const t = monday - 48 * HOUR_MS + i * HOUR_MS;
    let close = opts.fridayClose;
    let high = opts.fridayClose;
    let low = opts.fridayClose;
    if (i === 24) high = opts.weekendHigh; // Sun 00:00 high
    if (i === 36) low = opts.weekendLow; // Sun 12:00 low
    if (i === 47) close = opts.sundayClose; // Sun 23:00 close
    cs.push(bar(t, { high, low, close }));
  }
  // Monday 00:00 UTC entry candle
  cs.push(bar(monday, { open: opts.mondayOpen, close: opts.mondayOpen, high: opts.mondayOpen, low: opts.mondayOpen }));
  return cs;
}

describe("evaluateWeekendMr — positive path (spec §4.4)", () => {
  it("fires SHORT when weekend pumped >3% and Monday open within 1% of Sunday close", () => {
    const candles = buildScenario({
      fridayClose: 2_600,
      weekendHigh: 2_720,
      weekendLow: 2_580,
      sundayClose: 2_705,
      mondayOpen: 2_706,
    });
    const r = evaluateWeekendMr({ symbol: "ETHUSDT", candles, hasExistingPosition: false });
    expect(r.type).toBe("FIRE");
    if (r.type !== "FIRE") return;
    expect(r.signal.strategy).toBe("WEEKEND_MR");
    expect(r.signal.direction).toBe("SHORT");
    expect(r.signal.entryPrice).toBe(2_706);
    // Stop = weekend_high × 1.005 = 2_733.60
    expect(r.signal.stopPrice).toBeCloseTo(2_733.6, 4);
    // tp1 = friday_close + 0.5 × (sunday_close − friday_close) = 2_652.50
    expect(r.signal.tp1Price).toBeCloseTo(2_652.5, 4);
    // tp2 = friday_close = 2_600
    expect(r.signal.tp2Price).toBe(2_600);
    expect(r.signal.tp1AllocationPct).toBe(70);
    // time stop = Monday + 32h = Tue 08:00 UTC
    expect(r.signal.timeStopUtc).toBe(Date.UTC(2024, 9, 15, 8, 0, 0, 0));
  });

  it("fires LONG when weekend dumped >3%", () => {
    const candles = buildScenario({
      fridayClose: 2_700,
      weekendHigh: 2_720,
      weekendLow: 2_500,
      sundayClose: 2_580,
      mondayOpen: 2_580,
    });
    const r = evaluateWeekendMr({ symbol: "ETHUSDT", candles, hasExistingPosition: false });
    expect(r.type).toBe("FIRE");
    if (r.type !== "FIRE") return;
    expect(r.signal.direction).toBe("LONG");
    // Stop = weekend_low × 0.995
    expect(r.signal.stopPrice).toBeCloseTo(2_500 * 0.995, 4);
  });
});

describe("evaluateWeekendMr — negative path", () => {
  it("SKIP NOT_MONDAY_OPEN on Tuesday 00:00", () => {
    // Just supply a single Tuesday candle.
    const tuesday = Date.UTC(2024, 9, 15, 0, 0, 0);
    const r = evaluateWeekendMr({
      symbol: "ETHUSDT",
      candles: [bar(tuesday, { close: 2_700 })],
      hasExistingPosition: false,
    });
    expect(r.type).toBe("SKIP");
    if (r.type === "SKIP") expect(r.reason).toBe("NOT_MONDAY_OPEN");
  });

  it("SKIP MOVE_TOO_SMALL when weekend move within ±3%", () => {
    const candles = buildScenario({
      fridayClose: 2_700,
      weekendHigh: 2_730,
      weekendLow: 2_680,
      sundayClose: 2_720, // +0.74%
      mondayOpen: 2_720,
    });
    const r = evaluateWeekendMr({ symbol: "ETHUSDT", candles, hasExistingPosition: false });
    expect(r.type).toBe("SKIP");
    if (r.type === "SKIP") expect(r.reason).toBe("MOVE_TOO_SMALL");
  });

  it("SKIP GAP_TOO_LARGE when Monday opens >1% from Sunday close", () => {
    const candles = buildScenario({
      fridayClose: 2_600,
      weekendHigh: 2_720,
      weekendLow: 2_580,
      sundayClose: 2_705,
      mondayOpen: 2_750, // +1.66% gap
    });
    const r = evaluateWeekendMr({ symbol: "ETHUSDT", candles, hasExistingPosition: false });
    expect(r.type).toBe("SKIP");
    if (r.type === "SKIP") expect(r.reason).toBe("GAP_TOO_LARGE");
  });

  it("SKIP EXISTING_POSITION", () => {
    const candles = buildScenario({
      fridayClose: 2_600,
      weekendHigh: 2_720,
      weekendLow: 2_580,
      sundayClose: 2_705,
      mondayOpen: 2_706,
    });
    const r = evaluateWeekendMr({ symbol: "ETHUSDT", candles, hasExistingPosition: true });
    expect(r.type).toBe("SKIP");
    if (r.type === "SKIP") expect(r.reason).toBe("EXISTING_POSITION");
  });

  it("SKIP FRIDAY_CLOSE_MISSING when Friday 23:00 candle absent", () => {
    const monday = Date.UTC(2024, 9, 14, 0, 0, 0);
    const candles: Candle[] = [bar(monday, { close: 2_700 })]; // only Monday
    const r = evaluateWeekendMr({ symbol: "ETHUSDT", candles, hasExistingPosition: false });
    expect(r.type).toBe("SKIP");
    if (r.type === "SKIP") expect(r.reason).toBe("FRIDAY_CLOSE_MISSING");
  });
});
