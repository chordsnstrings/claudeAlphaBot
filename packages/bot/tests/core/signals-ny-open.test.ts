import { describe, expect, it } from "vitest";

import type { Candle } from "@hydra/shared";

import {
  DEFAULT_NY_STOP_BUFFER_ATR,
  DEFAULT_NY_TP1_R,
  DEFAULT_NY_TP2_R,
  evaluateNyOpen,
} from "../../src/core/signals-ny-open.js";
import { startOfUtcDay } from "../../src/core/sessions.js";

const HOUR_MS = 3_600_000;

function bar(openTime: number, p: { high: number; low: number; close: number; volume: number; open?: number }): Candle {
  return {
    symbol: "ETHUSDT",
    openTime,
    closeTime: openTime + HOUR_MS - 1,
    open: p.open ?? p.close,
    high: p.high,
    low: p.low,
    close: p.close,
    volume: p.volume,
  };
}

/** Wednesday 2024-10-16. */
function buildScenario(opts: {
  /** UTC date (default Wed 2024-10-16). */
  dateKey?: string;
  breakoutHour: number; // 13 or 14
  breakoutClose: number;
  breakoutVolume: number;
  baselineVolume: number;
  earlierWindowCandles?: readonly { hour: number; close: number; volume: number }[];
}): Candle[] {
  const dateKey = opts.dateKey ?? "2024-10-16";
  const dayStart = startOfUtcDay(dateKey);
  const cs: Candle[] = [];
  // 20 baseline candles BEFORE the day for volume average.
  for (let i = 20; i > 0; i--) {
    const t = dayStart - i * HOUR_MS;
    cs.push(bar(t, { high: 2_615, low: 2_605, close: 2_610, volume: opts.baselineVolume }));
  }
  // Pre-NY window 11:00-12:00 UTC: pre_high 2_620, pre_low 2_595, pre_open 2_612
  cs.push(bar(dayStart + 11 * HOUR_MS, { open: 2_612, high: 2_620, low: 2_605, close: 2_615, volume: opts.baselineVolume }));
  cs.push(bar(dayStart + 12 * HOUR_MS, { high: 2_618, low: 2_595, close: 2_600, volume: opts.baselineVolume }));
  // Optional earlier candles in NY window (hours 13..)
  for (const e of opts.earlierWindowCandles ?? []) {
    cs.push(bar(dayStart + e.hour * HOUR_MS, { high: e.close + 5, low: e.close - 5, close: e.close, volume: e.volume }));
  }
  // Breakout candle
  cs.push(
    bar(dayStart + opts.breakoutHour * HOUR_MS, {
      open: opts.breakoutClose + 5,
      high: opts.breakoutClose + 10,
      low: opts.breakoutClose - 5,
      close: opts.breakoutClose,
      volume: opts.breakoutVolume,
    }),
  );
  return cs;
}

const ATR = 12; // matches spec §3.4 worked example

describe("evaluateNyOpen — positive (spec §3.4)", () => {
  it("fires SHORT on Wed 14:00 UTC ETH breakout below pre-low with 1.6× vol", () => {
    const candles = buildScenario({
      breakoutHour: 14,
      breakoutClose: 2_590,
      breakoutVolume: 28_000 * 1.6,
      baselineVolume: 28_000,
    });
    const r = evaluateNyOpen({ symbol: "ETHUSDT", candles, atr: ATR, hasExistingPosition: false });
    expect(r.type).toBe("FIRE");
    if (r.type !== "FIRE") return;
    expect(r.signal.strategy).toBe("NY_OPEN");
    expect(r.signal.direction).toBe("SHORT");
    expect(r.signal.entryPrice).toBe(2_590);
    // Stop = pre_high 2_620 + 0.4 × 12 = 2_624.80
    expect(r.signal.stopPrice).toBeCloseTo(2_620 + DEFAULT_NY_STOP_BUFFER_ATR * ATR, 6);
    expect(r.signal.stopPrice).toBeCloseTo(2_624.8, 6);
    // Risk dist = 34.80
    const risk = 2_624.8 - 2_590;
    expect(r.signal.tp1Price).toBeCloseTo(2_590 - DEFAULT_NY_TP1_R * risk, 6);
    expect(r.signal.tp2Price).toBeCloseTo(2_590 - DEFAULT_NY_TP2_R * risk, 6);
    // Worked example: TP1 = 2_537.80 ; TP2 = 2_503.00
    expect(r.signal.tp1Price).toBeCloseTo(2_537.80, 4);
    expect(r.signal.tp2Price).toBeCloseTo(2_503.00, 4);
  });

  it("fires LONG when close breaks above pre_high with confirming volume", () => {
    const candles = buildScenario({
      breakoutHour: 13,
      breakoutClose: 2_625,
      breakoutVolume: 28_000 * 1.5,
      baselineVolume: 28_000,
    });
    const r = evaluateNyOpen({ symbol: "ETHUSDT", candles, atr: ATR, hasExistingPosition: false });
    expect(r.type).toBe("FIRE");
    if (r.type !== "FIRE") return;
    expect(r.signal.direction).toBe("LONG");
  });

  it("time stop = 20:00 UTC same day", () => {
    const candles = buildScenario({
      breakoutHour: 14,
      breakoutClose: 2_590,
      breakoutVolume: 28_000 * 1.6,
      baselineVolume: 28_000,
    });
    const r = evaluateNyOpen({ symbol: "ETHUSDT", candles, atr: ATR, hasExistingPosition: false });
    if (r.type !== "FIRE") throw new Error("expected FIRE");
    expect(r.signal.timeStopUtc).toBe(Date.UTC(2024, 9, 16, 20, 0, 0, 0));
  });
});

describe("evaluateNyOpen — negative", () => {
  it("SKIP VOLUME_INSUFFICIENT when volume < 1.4× avg", () => {
    const candles = buildScenario({
      breakoutHour: 14,
      breakoutClose: 2_590,
      breakoutVolume: 28_000 * 1.0, // exactly avg
      baselineVolume: 28_000,
    });
    const r = evaluateNyOpen({ symbol: "ETHUSDT", candles, atr: ATR, hasExistingPosition: false });
    expect(r.type).toBe("SKIP");
    if (r.type === "SKIP") expect(r.reason).toBe("VOLUME_INSUFFICIENT");
  });

  it("SKIP WEEKEND on Saturday", () => {
    const candles = buildScenario({
      dateKey: "2024-10-12", // Saturday
      breakoutHour: 14,
      breakoutClose: 2_590,
      breakoutVolume: 28_000 * 1.6,
      baselineVolume: 28_000,
    });
    const r = evaluateNyOpen({ symbol: "ETHUSDT", candles, atr: ATR, hasExistingPosition: false });
    expect(r.type).toBe("SKIP");
    if (r.type === "SKIP") expect(r.reason).toBe("WEEKEND");
  });

  it("SKIP OUTSIDE_WINDOW at 15:00 UTC (past breakout window 13-14)", () => {
    const candles = buildScenario({
      breakoutHour: 15,
      breakoutClose: 2_590,
      breakoutVolume: 28_000 * 1.6,
      baselineVolume: 28_000,
    });
    const r = evaluateNyOpen({ symbol: "ETHUSDT", candles, atr: ATR, hasExistingPosition: false });
    expect(r.type).toBe("SKIP");
    if (r.type === "SKIP") expect(r.reason).toBe("OUTSIDE_WINDOW");
  });

  it("SKIP NO_BREAKOUT when close stays inside the pre-range", () => {
    const candles = buildScenario({
      breakoutHour: 14,
      breakoutClose: 2_610, // inside [2_595, 2_620]
      breakoutVolume: 28_000 * 1.6,
      baselineVolume: 28_000,
    });
    const r = evaluateNyOpen({ symbol: "ETHUSDT", candles, atr: ATR, hasExistingPosition: false });
    expect(r.type).toBe("SKIP");
    if (r.type === "SKIP") expect(r.reason).toBe("NO_BREAKOUT");
  });

  it("SKIP PRIOR_BREAKOUT when an earlier candle in the window already broke", () => {
    const candles = buildScenario({
      breakoutHour: 14,
      breakoutClose: 2_590,
      breakoutVolume: 28_000 * 1.6,
      baselineVolume: 28_000,
      earlierWindowCandles: [{ hour: 13, close: 2_625, volume: 28_000 * 1.6 }], // already broke up at 13
    });
    const r = evaluateNyOpen({ symbol: "ETHUSDT", candles, atr: ATR, hasExistingPosition: false });
    expect(r.type).toBe("SKIP");
    if (r.type === "SKIP") expect(r.reason).toBe("PRIOR_BREAKOUT");
  });

  it("SKIP RANGE_TOO_WIDE when pre-range > 2.0%", () => {
    // Pre-NY range tweaked: open 2612, high 2680, low 2540 → 5.36%
    const dayStart = startOfUtcDay("2024-10-16");
    const cs: Candle[] = [];
    for (let i = 20; i > 0; i--) cs.push(bar(dayStart - i * HOUR_MS, { high: 2_615, low: 2_605, close: 2_610, volume: 28_000 }));
    cs.push(bar(dayStart + 11 * HOUR_MS, { open: 2_612, high: 2_680, low: 2_605, close: 2_640, volume: 28_000 }));
    cs.push(bar(dayStart + 12 * HOUR_MS, { high: 2_650, low: 2_540, close: 2_600, volume: 28_000 }));
    cs.push(bar(dayStart + 14 * HOUR_MS, { open: 2_590, high: 2_595, low: 2_500, close: 2_535, volume: 28_000 * 1.6 }));
    const r = evaluateNyOpen({ symbol: "ETHUSDT", candles: cs, atr: ATR, hasExistingPosition: false });
    expect(r.type).toBe("SKIP");
    if (r.type === "SKIP") expect(r.reason).toBe("RANGE_TOO_WIDE");
  });

  it("SKIP EXISTING_POSITION when symbol already has open position", () => {
    const candles = buildScenario({
      breakoutHour: 14,
      breakoutClose: 2_590,
      breakoutVolume: 28_000 * 1.6,
      baselineVolume: 28_000,
    });
    const r = evaluateNyOpen({ symbol: "ETHUSDT", candles, atr: ATR, hasExistingPosition: true });
    expect(r.type).toBe("SKIP");
    if (r.type === "SKIP") expect(r.reason).toBe("EXISTING_POSITION");
  });
});
