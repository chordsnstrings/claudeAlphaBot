import { describe, expect, it } from "vitest";

import type { Candle } from "@hydra/shared";

import {
  DEFAULT_STOP_BUFFER_ATR,
  DEFAULT_TP1_R,
  DEFAULT_TP2_R,
  evaluateArb,
} from "../../src/core/signals-arb.js";
import { startOfUtcDay } from "../../src/core/sessions.js";

const HOUR_MS = 3_600_000;

interface CandleParams {
  high: number;
  low: number;
  close: number;
  volume: number;
  open?: number;
}

function candle(openTime: number, p: CandleParams): Candle {
  return {
    symbol: "BTCUSDT",
    openTime,
    closeTime: openTime + HOUR_MS - 1,
    open: p.open ?? p.close,
    high: p.high,
    low: p.low,
    close: p.close,
    volume: p.volume,
  };
}

/**
 * Build a "standard" ARB scenario:
 *   - Tuesday Oct 15, 2024 (a weekday in UTC)
 *   - 7 Asian candles (00:00-06:00) with controlled high=67_450, low=66_900, open=67_200
 *   - 20 trailing volume-history candles BEFORE the Asian session for volume avg
 *   - Optional pre-breakout candles inside the breakout window
 *   - Final candle = the candle being evaluated
 */
function buildBaseScenario(opts: {
  /** UTC date string YYYY-MM-DD; default Tuesday 2024-10-15 */
  dateKey?: string;
  /** Volume on the breakout candle. */
  breakoutVolume: number;
  /** Average volume of the 20 trailing pre-Asian candles. */
  baselineVolume: number;
  /** The breakout candle's close. */
  breakoutClose: number;
  /** Hour-of-day for the breakout candle (within the ARB window 7-10). */
  breakoutHour: number;
  /** Optionally inject earlier breakout-window candles (e.g. for first-only test). */
  earlierWindowCandles?: readonly { hour: number; close: number; volume: number }[];
}): Candle[] {
  const dateKey = opts.dateKey ?? "2024-10-15";
  const dayStart = startOfUtcDay(dateKey);
  const cs: Candle[] = [];
  // 20 baseline volume candles in the previous day (16:00-23:00 of Oct 14, plus
  // earlier hours to fill 20). These provide volume history with non-breakout closes.
  for (let i = 20; i > 0; i--) {
    const t = dayStart - i * HOUR_MS;
    cs.push(candle(t, { high: 67_300, low: 67_200, close: 67_250, volume: opts.baselineVolume }));
  }
  // 7 Asian candles establishing high=67_450, low=66_900, open=67_200
  cs.push(candle(dayStart + 0 * HOUR_MS, { open: 67_200, high: 67_250, low: 67_100, close: 67_210, volume: opts.baselineVolume }));
  cs.push(candle(dayStart + 1 * HOUR_MS, { high: 67_300, low: 67_150, close: 67_260, volume: opts.baselineVolume }));
  cs.push(candle(dayStart + 2 * HOUR_MS, { high: 67_400, low: 67_200, close: 67_350, volume: opts.baselineVolume }));
  cs.push(candle(dayStart + 3 * HOUR_MS, { high: 67_450, low: 67_280, close: 67_420, volume: opts.baselineVolume }));
  cs.push(candle(dayStart + 4 * HOUR_MS, { high: 67_430, low: 66_900, close: 66_950, volume: opts.baselineVolume }));
  cs.push(candle(dayStart + 5 * HOUR_MS, { high: 67_000, low: 66_910, close: 66_980, volume: opts.baselineVolume }));
  cs.push(candle(dayStart + 6 * HOUR_MS, { high: 67_050, low: 66_920, close: 67_010, volume: opts.baselineVolume }));
  // Optional earlier window candles (must come BEFORE breakoutHour)
  for (const e of opts.earlierWindowCandles ?? []) {
    cs.push(candle(dayStart + e.hour * HOUR_MS, { high: e.close + 5, low: e.close - 5, close: e.close, volume: e.volume }));
  }
  // The breakout candle itself
  cs.push(
    candle(dayStart + opts.breakoutHour * HOUR_MS, {
      open: opts.breakoutClose - 10,
      high: opts.breakoutClose + 10,
      low: opts.breakoutClose - 20,
      close: opts.breakoutClose,
      volume: opts.breakoutVolume,
    }),
  );
  return cs;
}

const ATR_DEFAULT = 420; // matches spec §2.4 worked example

describe("evaluateArb — positive path", () => {
  it("fires LONG when 0.8% range, breakout above high, 1.5× volume", () => {
    const candles = buildBaseScenario({
      breakoutVolume: 5_200 * 1.5,
      baselineVolume: 5_200,
      breakoutClose: 67_520,
      breakoutHour: 8,
    });
    const decision = evaluateArb({
      symbol: "BTCUSDT",
      candles,
      atr: ATR_DEFAULT,
      hasExistingPosition: false,
    });
    expect(decision.type).toBe("FIRE");
    if (decision.type !== "FIRE") return;
    expect(decision.signal.strategy).toBe("ARB");
    expect(decision.signal.direction).toBe("LONG");
    expect(decision.signal.entryPrice).toBe(67_520);
    expect(decision.signal.tp1AllocationPct).toBe(50);
    expect(decision.signal.symbol).toBe("BTCUSDT");
  });

  it("computes stop price = asian_low − 0.5·ATR for LONG (spec §2.3)", () => {
    const candles = buildBaseScenario({
      breakoutVolume: 5_200 * 1.5,
      baselineVolume: 5_200,
      breakoutClose: 67_520,
      breakoutHour: 8,
    });
    const decision = evaluateArb({
      symbol: "BTCUSDT",
      candles,
      atr: ATR_DEFAULT,
      hasExistingPosition: false,
    });
    if (decision.type !== "FIRE") throw new Error("expected FIRE");
    const expectedStop = 66_900 - DEFAULT_STOP_BUFFER_ATR * ATR_DEFAULT;
    expect(decision.signal.stopPrice).toBeCloseTo(expectedStop, 6);
    // Worked example says stop = $66,690
    expect(decision.signal.stopPrice).toBeCloseTo(66_690, 6);
  });

  it("computes TP1 at 1.5R and TP2 at 3.0R from entry (spec §2.3)", () => {
    const candles = buildBaseScenario({
      breakoutVolume: 5_200 * 1.5,
      baselineVolume: 5_200,
      breakoutClose: 67_520,
      breakoutHour: 8,
    });
    const decision = evaluateArb({
      symbol: "BTCUSDT",
      candles,
      atr: ATR_DEFAULT,
      hasExistingPosition: false,
    });
    if (decision.type !== "FIRE") throw new Error("expected FIRE");
    const riskDistance = 67_520 - 66_690; // 830
    expect(decision.signal.tp1Price).toBeCloseTo(67_520 + DEFAULT_TP1_R * riskDistance, 6);
    expect(decision.signal.tp2Price).toBeCloseTo(67_520 + DEFAULT_TP2_R * riskDistance, 6);
    // Worked example: TP1 = 68_765, TP2 = 70_010
    expect(decision.signal.tp1Price).toBeCloseTo(68_765, 6);
    expect(decision.signal.tp2Price).toBeCloseTo(70_010, 6);
    // Breakeven at 1R = 67_520 + 830 = 68_350
    expect(decision.signal.breakevenTriggerPrice).toBeCloseTo(68_350, 6);
  });

  it("sets time_stop = 20:00 UTC same day", () => {
    const candles = buildBaseScenario({
      breakoutVolume: 5_200 * 1.5,
      baselineVolume: 5_200,
      breakoutClose: 67_520,
      breakoutHour: 8,
    });
    const decision = evaluateArb({
      symbol: "BTCUSDT",
      candles,
      atr: ATR_DEFAULT,
      hasExistingPosition: false,
    });
    if (decision.type !== "FIRE") throw new Error("expected FIRE");
    expect(decision.signal.timeStopUtc).toBe(Date.UTC(2024, 9, 15, 20, 0, 0, 0));
  });

  it("fires SHORT when close breaks below asian_low with confirming volume", () => {
    const candles = buildBaseScenario({
      breakoutVolume: 5_200 * 1.5,
      baselineVolume: 5_200,
      breakoutClose: 66_800, // below asian_low 66_900
      breakoutHour: 8,
    });
    const decision = evaluateArb({
      symbol: "BTCUSDT",
      candles,
      atr: ATR_DEFAULT,
      hasExistingPosition: false,
    });
    if (decision.type !== "FIRE") throw new Error("expected FIRE");
    expect(decision.signal.direction).toBe("SHORT");
    // SHORT stop = asian_high + 0.5·ATR = 67_450 + 210 = 67_660
    expect(decision.signal.stopPrice).toBeCloseTo(67_660, 6);
    const riskDistance = 67_660 - 66_800; // 860
    expect(decision.signal.tp1Price).toBeCloseTo(66_800 - 1.5 * riskDistance, 6);
    expect(decision.signal.tp2Price).toBeCloseTo(66_800 - 3.0 * riskDistance, 6);
  });
});

describe("evaluateArb — negative paths", () => {
  it("SKIP when volume < 1.3× trailing average", () => {
    const candles = buildBaseScenario({
      breakoutVolume: 5_200, // 1.0×
      baselineVolume: 5_200,
      breakoutClose: 67_520,
      breakoutHour: 8,
    });
    const decision = evaluateArb({
      symbol: "BTCUSDT",
      candles,
      atr: ATR_DEFAULT,
      hasExistingPosition: false,
    });
    expect(decision.type).toBe("SKIP");
    if (decision.type !== "SKIP") return;
    expect(decision.reason).toBe("VOLUME_INSUFFICIENT");
  });

  it("SKIP on Saturday UTC (weekend filter)", () => {
    // 2024-10-12 is a Saturday in UTC.
    const candles = buildBaseScenario({
      dateKey: "2024-10-12",
      breakoutVolume: 5_200 * 1.5,
      baselineVolume: 5_200,
      breakoutClose: 67_520,
      breakoutHour: 8,
    });
    const decision = evaluateArb({
      symbol: "BTCUSDT",
      candles,
      atr: ATR_DEFAULT,
      hasExistingPosition: false,
    });
    expect(decision.type).toBe("SKIP");
    if (decision.type === "SKIP") expect(decision.reason).toBe("WEEKEND");
  });

  it("SKIP at hour 12 UTC (past breakout window 07:00-10:59)", () => {
    const candles = buildBaseScenario({
      breakoutVolume: 5_200 * 1.5,
      baselineVolume: 5_200,
      breakoutClose: 67_520,
      breakoutHour: 12,
    });
    const decision = evaluateArb({
      symbol: "BTCUSDT",
      candles,
      atr: ATR_DEFAULT,
      hasExistingPosition: false,
    });
    expect(decision.type).toBe("SKIP");
    if (decision.type === "SKIP") expect(decision.reason).toBe("OUTSIDE_WINDOW");
  });

  it("SKIP when no breakout (close inside range)", () => {
    const candles = buildBaseScenario({
      breakoutVolume: 5_200 * 1.5,
      baselineVolume: 5_200,
      breakoutClose: 67_300, // inside [66_900, 67_450]
      breakoutHour: 8,
    });
    const decision = evaluateArb({
      symbol: "BTCUSDT",
      candles,
      atr: ATR_DEFAULT,
      hasExistingPosition: false,
    });
    expect(decision.type).toBe("SKIP");
    if (decision.type === "SKIP") expect(decision.reason).toBe("NO_BREAKOUT");
  });

  it("first-breakout-only: second breakout in same window does NOT fire", () => {
    // Earlier candle at hour 7 already broke high → current candle at hour 9
    // must SKIP with reason PRIOR_BREAKOUT.
    const candles = buildBaseScenario({
      breakoutVolume: 5_200 * 1.5,
      baselineVolume: 5_200,
      breakoutClose: 67_600,
      breakoutHour: 9,
      earlierWindowCandles: [{ hour: 7, close: 67_500, volume: 5_200 * 1.4 }],
    });
    const decision = evaluateArb({
      symbol: "BTCUSDT",
      candles,
      atr: ATR_DEFAULT,
      hasExistingPosition: false,
    });
    expect(decision.type).toBe("SKIP");
    if (decision.type === "SKIP") expect(decision.reason).toBe("PRIOR_BREAKOUT");
  });

  it("SKIP when range too tight (< 0.4%)", () => {
    // Custom: build a zero-range Asian session by overriding all candles to identical values.
    const dayStart = startOfUtcDay("2024-10-15");
    const cs: Candle[] = [];
    for (let i = 20; i > 0; i--) {
      cs.push(candle(dayStart - i * HOUR_MS, { high: 100, low: 100, close: 100, volume: 1000 }));
    }
    for (let h = 0; h < 7; h++) {
      cs.push(candle(dayStart + h * HOUR_MS, { open: 100, high: 100.1, low: 99.95, close: 100, volume: 1000 }));
    }
    cs.push(candle(dayStart + 8 * HOUR_MS, { open: 100, high: 101, low: 100, close: 100.5, volume: 2000 }));
    const decision = evaluateArb({
      symbol: "BTCUSDT",
      candles: cs,
      atr: 1,
      hasExistingPosition: false,
    });
    expect(decision.type).toBe("SKIP");
    if (decision.type === "SKIP") expect(decision.reason).toBe("RANGE_TOO_TIGHT");
  });

  it("SKIP when range too wide (> 2.5%)", () => {
    const dayStart = startOfUtcDay("2024-10-15");
    const cs: Candle[] = [];
    for (let i = 20; i > 0; i--) {
      cs.push(candle(dayStart - i * HOUR_MS, { high: 100, low: 100, close: 100, volume: 1000 }));
    }
    // Wide range: open=100, high=110, low=95 → range = 15% (way over 2.5)
    cs.push(candle(dayStart + 0 * HOUR_MS, { open: 100, high: 110, low: 95, close: 105, volume: 1000 }));
    for (let h = 1; h < 7; h++) {
      cs.push(candle(dayStart + h * HOUR_MS, { high: 110, low: 95, close: 105, volume: 1000 }));
    }
    cs.push(candle(dayStart + 8 * HOUR_MS, { open: 105, high: 115, low: 105, close: 112, volume: 2000 }));
    const decision = evaluateArb({
      symbol: "BTCUSDT",
      candles: cs,
      atr: 1,
      hasExistingPosition: false,
    });
    expect(decision.type).toBe("SKIP");
    if (decision.type === "SKIP") expect(decision.reason).toBe("RANGE_TOO_WIDE");
  });

  it("SKIP when an existing position is already open on the symbol", () => {
    const candles = buildBaseScenario({
      breakoutVolume: 5_200 * 1.5,
      baselineVolume: 5_200,
      breakoutClose: 67_520,
      breakoutHour: 8,
    });
    const decision = evaluateArb({
      symbol: "BTCUSDT",
      candles,
      atr: ATR_DEFAULT,
      hasExistingPosition: true,
    });
    expect(decision.type).toBe("SKIP");
    if (decision.type === "SKIP") expect(decision.reason).toBe("EXISTING_POSITION");
  });

  it("SKIP when ATR is non-finite or non-positive (insufficient data)", () => {
    const candles = buildBaseScenario({
      breakoutVolume: 5_200 * 1.5,
      baselineVolume: 5_200,
      breakoutClose: 67_520,
      breakoutHour: 8,
    });
    const r1 = evaluateArb({ symbol: "BTCUSDT", candles, atr: Number.NaN, hasExistingPosition: false });
    expect(r1.type).toBe("SKIP");
    if (r1.type === "SKIP") expect(r1.reason).toBe("INSUFFICIENT_DATA");
    const r2 = evaluateArb({ symbol: "BTCUSDT", candles, atr: 0, hasExistingPosition: false });
    expect(r2.type).toBe("SKIP");
  });
});
