import { describe, expect, it } from "vitest";

import type { Candle } from "@hydra/shared";

import {
  ARB_BREAKOUT_WINDOW,
  ASIAN_SESSION,
  NY_BREAKOUT_WINDOW,
  PRE_NY_WINDOW,
  asianSessionRange,
  candleInWindow,
  candlesInWindow,
  hasPriorBreakout,
  isUtcWeekend,
  preNyRange,
  sessionRange,
  startOfUtcDay,
  utcDateKey,
  utcHourStart,
} from "../../src/core/sessions.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function candleAt(
  openTime: number,
  { open, high, low, close, volume }: { open: number; high: number; low: number; close: number; volume: number },
): Candle {
  return {
    symbol: "BTCUSDT",
    openTime,
    closeTime: openTime + HOUR_MS - 1,
    open,
    high,
    low,
    close,
    volume,
  };
}

describe("utcDateKey / startOfUtcDay", () => {
  it("formats midnight UTC", () => {
    const t = Date.UTC(2024, 9, 15, 0, 0, 0, 0); // Oct 15, 2024 00:00 UTC
    expect(utcDateKey(t)).toBe("2024-10-15");
  });

  it("zero-pads single-digit month and day", () => {
    expect(utcDateKey(Date.UTC(2024, 0, 3))).toBe("2024-01-03");
  });

  it("is a round-trip for midnight", () => {
    const ms = startOfUtcDay("2024-11-30");
    expect(utcDateKey(ms)).toBe("2024-11-30");
    expect(new Date(ms).getUTCHours()).toBe(0);
  });

  it("handles month boundary (Nov 30 → Dec 1 UTC) without drift", () => {
    // 23:59 UTC on Nov 30 is still "2024-11-30". 00:00 UTC next day is
    // "2024-12-01". This guards against off-by-one when the local
    // timezone is west of UTC.
    const lateNov = Date.UTC(2024, 10, 30, 23, 59, 59, 999);
    expect(utcDateKey(lateNov)).toBe("2024-11-30");
    const midnightDec = Date.UTC(2024, 11, 1, 0, 0, 0, 0);
    expect(utcDateKey(midnightDec)).toBe("2024-12-01");
  });

  it("handles year boundary", () => {
    expect(utcDateKey(Date.UTC(2023, 11, 31, 23, 59))).toBe("2023-12-31");
    expect(utcDateKey(Date.UTC(2024, 0, 1, 0, 0))).toBe("2024-01-01");
  });

  it("handles leap-year Feb 29", () => {
    expect(startOfUtcDay("2024-02-29")).toBe(Date.UTC(2024, 1, 29));
    expect(utcDateKey(Date.UTC(2024, 1, 29))).toBe("2024-02-29");
  });

  it("throws on malformed keys", () => {
    expect(() => startOfUtcDay("not-a-date")).toThrow();
    expect(() => startOfUtcDay("2024-1-5")).toThrow();
    expect(() => startOfUtcDay("")).toThrow();
  });

  it("throws on non-existent calendar dates", () => {
    expect(() => startOfUtcDay("2023-02-29")).toThrow(); // 2023 not leap
    expect(() => startOfUtcDay("2024-02-30")).toThrow();
    expect(() => startOfUtcDay("2024-13-01")).toThrow();
    expect(() => startOfUtcDay("2024-04-31")).toThrow();
  });
});

describe("utcHourStart", () => {
  it("returns epoch-ms at the top of the given hour", () => {
    expect(utcHourStart("2024-10-15", 7)).toBe(Date.UTC(2024, 9, 15, 7));
    expect(utcHourStart("2024-10-15", 0)).toBe(Date.UTC(2024, 9, 15, 0));
    expect(utcHourStart("2024-10-15", 23)).toBe(Date.UTC(2024, 9, 15, 23));
  });

  it("throws on out-of-range hour", () => {
    expect(() => utcHourStart("2024-10-15", -1)).toThrow();
    expect(() => utcHourStart("2024-10-15", 24)).toThrow();
    expect(() => utcHourStart("2024-10-15", 1.5)).toThrow();
  });
});

describe("isUtcWeekend", () => {
  it("Sat and Sun are weekend", () => {
    // Oct 12, 2024 is a Saturday; Oct 13 is a Sunday.
    expect(isUtcWeekend(Date.UTC(2024, 9, 12, 12))).toBe(true);
    expect(isUtcWeekend(Date.UTC(2024, 9, 13, 0))).toBe(true);
  });

  it("Mon-Fri are not weekend", () => {
    // Oct 14 Mon, Oct 18 Fri.
    expect(isUtcWeekend(Date.UTC(2024, 9, 14))).toBe(false);
    expect(isUtcWeekend(Date.UTC(2024, 9, 18))).toBe(false);
  });
});

describe("candleInWindow", () => {
  const dateKey = "2024-10-15";

  it("includes the start and end hours (inclusive)", () => {
    const c0 = candleAt(utcHourStart(dateKey, 0), { open: 1, high: 1, low: 1, close: 1, volume: 1 });
    const c6 = candleAt(utcHourStart(dateKey, 6), { open: 1, high: 1, low: 1, close: 1, volume: 1 });
    expect(candleInWindow(c0, dateKey, ASIAN_SESSION)).toBe(true);
    expect(candleInWindow(c6, dateKey, ASIAN_SESSION)).toBe(true);
  });

  it("excludes the hour immediately AFTER endHour", () => {
    const c7 = candleAt(utcHourStart(dateKey, 7), { open: 1, high: 1, low: 1, close: 1, volume: 1 });
    expect(candleInWindow(c7, dateKey, ASIAN_SESSION)).toBe(false);
    // But it IS inside the ARB breakout window.
    expect(candleInWindow(c7, dateKey, ARB_BREAKOUT_WINDOW)).toBe(true);
  });

  it("rejects candles from other UTC days", () => {
    const prevDay = candleAt(utcHourStart("2024-10-14", 5), { open: 1, high: 1, low: 1, close: 1, volume: 1 });
    const nextDay = candleAt(utcHourStart("2024-10-16", 5), { open: 1, high: 1, low: 1, close: 1, volume: 1 });
    expect(candleInWindow(prevDay, dateKey, ASIAN_SESSION)).toBe(false);
    expect(candleInWindow(nextDay, dateKey, ASIAN_SESSION)).toBe(false);
  });

  it("correctly partitions hours across all four canonical windows", () => {
    const dayStart = startOfUtcDay(dateKey);
    for (let h = 0; h < 24; h++) {
      const c = candleAt(dayStart + h * HOUR_MS, { open: 1, high: 1, low: 1, close: 1, volume: 1 });
      expect(candleInWindow(c, dateKey, ASIAN_SESSION)).toBe(h >= 0 && h <= 6);
      expect(candleInWindow(c, dateKey, ARB_BREAKOUT_WINDOW)).toBe(h >= 7 && h <= 10);
      expect(candleInWindow(c, dateKey, PRE_NY_WINDOW)).toBe(h === 11 || h === 12);
      expect(candleInWindow(c, dateKey, NY_BREAKOUT_WINDOW)).toBe(h === 13 || h === 14);
    }
  });
});

describe("candlesInWindow", () => {
  it("picks all candles whose openTime is within the window", () => {
    const dateKey = "2024-10-15";
    const all: Candle[] = [];
    for (let h = 0; h < 24; h++) {
      all.push(candleAt(utcHourStart(dateKey, h), { open: 100, high: 100, low: 100, close: 100, volume: h }));
    }
    const asian = candlesInWindow(all, dateKey, ASIAN_SESSION);
    expect(asian).toHaveLength(7);
    expect(asian[0]!.openTime).toBe(utcHourStart(dateKey, 0));
    expect(asian[6]!.openTime).toBe(utcHourStart(dateKey, 6));
  });
});

describe("asianSessionRange", () => {
  it("computes high, low, open, close, total volume over 00:00–06:59 UTC", () => {
    const dateKey = "2024-10-15";
    const dayStart = startOfUtcDay(dateKey);
    const asian = [
      candleAt(dayStart + 0 * HOUR_MS, { open: 67_200, high: 67_250, low: 67_100, close: 67_210, volume: 100 }),
      candleAt(dayStart + 1 * HOUR_MS, { open: 67_210, high: 67_300, low: 67_150, close: 67_260, volume: 120 }),
      candleAt(dayStart + 2 * HOUR_MS, { open: 67_260, high: 67_400, low: 67_200, close: 67_350, volume: 150 }),
      candleAt(dayStart + 3 * HOUR_MS, { open: 67_350, high: 67_450, low: 67_280, close: 67_420, volume: 180 }),
      candleAt(dayStart + 4 * HOUR_MS, { open: 67_420, high: 67_430, low: 66_900, close: 66_950, volume: 220 }),
      candleAt(dayStart + 5 * HOUR_MS, { open: 66_950, high: 67_000, low: 66_910, close: 66_980, volume: 140 }),
      candleAt(dayStart + 6 * HOUR_MS, { open: 66_980, high: 67_050, low: 66_920, close: 67_010, volume: 90 }),
    ];
    // Plus a candle outside the session to ensure it's excluded.
    const outside = candleAt(dayStart + 8 * HOUR_MS, { open: 67_010, high: 70_000, low: 60_000, close: 67_500, volume: 999 });
    const range = asianSessionRange([...asian, outside], dateKey);
    expect(range).not.toBeNull();
    expect(range!.high).toBe(67_450);
    expect(range!.low).toBe(66_900);
    expect(range!.open).toBe(67_200);
    expect(range!.close).toBe(67_010);
    expect(range!.totalVolume).toBe(100 + 120 + 150 + 180 + 220 + 140 + 90);
    expect(range!.candleCount).toBe(7);
  });

  it("returns null when no candles fall in the session", () => {
    const dateKey = "2024-10-15";
    // All candles on a different day.
    const cs = Array.from({ length: 5 }, (_, i) =>
      candleAt(utcHourStart("2024-10-14", i), { open: 1, high: 1, low: 1, close: 1, volume: 1 }),
    );
    expect(asianSessionRange(cs, dateKey)).toBeNull();
  });

  it("handles candles spanning multiple days — only the requested day is aggregated", () => {
    const dayStart15 = startOfUtcDay("2024-10-15");
    const dayStart16 = startOfUtcDay("2024-10-16");
    const all: Candle[] = [
      candleAt(dayStart15 + 0 * HOUR_MS, { open: 100, high: 105, low: 95, close: 102, volume: 10 }),
      candleAt(dayStart15 + 6 * HOUR_MS, { open: 102, high: 110, low: 101, close: 108, volume: 12 }),
      // Next day at hour 0 — must NOT be included in the 15th's Asian range.
      candleAt(dayStart16 + 0 * HOUR_MS, { open: 200, high: 999, low: 1, close: 250, volume: 1_000 }),
    ];
    const range = asianSessionRange(all, "2024-10-15");
    expect(range).not.toBeNull();
    expect(range!.high).toBe(110);
    expect(range!.low).toBe(95);
    expect(range!.totalVolume).toBe(22);
  });
});

describe("preNyRange", () => {
  it("covers 11:00 and 12:00 UTC candles only", () => {
    const dateKey = "2024-10-16";
    const dayStart = startOfUtcDay(dateKey);
    const cs: Candle[] = [
      candleAt(dayStart + 10 * HOUR_MS, { open: 2_605, high: 2_612, low: 2_600, close: 2_611, volume: 5 }),
      candleAt(dayStart + 11 * HOUR_MS, { open: 2_611, high: 2_620, low: 2_605, close: 2_615, volume: 8 }),
      candleAt(dayStart + 12 * HOUR_MS, { open: 2_615, high: 2_618, low: 2_595, close: 2_600, volume: 9 }),
      candleAt(dayStart + 13 * HOUR_MS, { open: 2_600, high: 2_640, low: 2_598, close: 2_635, volume: 20 }),
    ];
    const range = preNyRange(cs, dateKey);
    expect(range).not.toBeNull();
    expect(range!.candleCount).toBe(2);
    expect(range!.high).toBe(2_620);
    expect(range!.low).toBe(2_595);
    expect(range!.open).toBe(2_611);
    expect(range!.close).toBe(2_600);
  });
});

describe("sessionRange — generic", () => {
  it("delegates to the given window", () => {
    const dateKey = "2024-10-15";
    const dayStart = startOfUtcDay(dateKey);
    const cs: Candle[] = [
      candleAt(dayStart + 13 * HOUR_MS, { open: 3_000, high: 3_100, low: 2_950, close: 3_080, volume: 1 }),
      candleAt(dayStart + 14 * HOUR_MS, { open: 3_080, high: 3_200, low: 3_070, close: 3_180, volume: 1 }),
    ];
    const r = sessionRange(cs, dateKey, NY_BREAKOUT_WINDOW);
    expect(r).not.toBeNull();
    expect(r!.high).toBe(3_200);
    expect(r!.low).toBe(2_950);
  });
});

describe("hasPriorBreakout", () => {
  const dateKey = "2024-10-15";
  const dayStart = startOfUtcDay(dateKey);
  const range = { high: 67_450, low: 66_900 };

  function breakoutCandles(closes: readonly number[]): Candle[] {
    // Produce candles at hours 7..(7+N-1) closing at the given values.
    return closes.map((close, i) =>
      candleAt(dayStart + (7 + i) * HOUR_MS, { open: close, high: close + 5, low: close - 5, close, volume: 1 }),
    );
  }

  it("returns false when no earlier candle closed outside the range", () => {
    const cs = breakoutCandles([67_200, 67_300, 67_400]); // all inside
    const currentOpen = dayStart + 10 * HOUR_MS; // hour 10 — will check hours 7,8,9
    expect(hasPriorBreakout(cs, currentOpen, ARB_BREAKOUT_WINDOW, range)).toBe(false);
  });

  it("returns true when an earlier candle closed above range.high", () => {
    const cs = breakoutCandles([67_200, 67_500, 67_300]); // hour 8 breaks high
    const currentOpen = dayStart + 10 * HOUR_MS;
    expect(hasPriorBreakout(cs, currentOpen, ARB_BREAKOUT_WINDOW, range)).toBe(true);
  });

  it("returns true when an earlier candle closed below range.low", () => {
    const cs = breakoutCandles([67_200, 66_800, 67_300]); // hour 8 breaks low
    const currentOpen = dayStart + 10 * HOUR_MS;
    expect(hasPriorBreakout(cs, currentOpen, ARB_BREAKOUT_WINDOW, range)).toBe(true);
  });

  it("does NOT count the current candle itself (strictly earlier only)", () => {
    // Current candle's own close is outside the range; must still return false
    // because the "first breakout only" check excludes the candle under test.
    const cs = breakoutCandles([67_200, 67_300, 67_400, 67_500]);
    const currentOpen = dayStart + 10 * HOUR_MS; // this is the 4th (67_500) candle
    expect(hasPriorBreakout(cs, currentOpen, ARB_BREAKOUT_WINDOW, range)).toBe(false);
  });

  it("ignores candles outside the breakout window (e.g. Asian-session close beyond range)", () => {
    const asianBreak = candleAt(dayStart + 3 * HOUR_MS, {
      open: 67_400,
      high: 67_500,
      low: 67_300,
      close: 67_500, // above range.high, but within ASIAN_SESSION hours
      volume: 1,
    });
    const cs = [asianBreak, ...breakoutCandles([67_200, 67_300])];
    const currentOpen = dayStart + 10 * HOUR_MS;
    expect(hasPriorBreakout(cs, currentOpen, ARB_BREAKOUT_WINDOW, range)).toBe(false);
  });

  it("ignores breakouts from previous days", () => {
    const priorDayStart = startOfUtcDay("2024-10-14");
    const priorBreak = candleAt(priorDayStart + 8 * HOUR_MS, {
      open: 67_500,
      high: 67_700,
      low: 67_400,
      close: 67_600, // outside today's range, but it's yesterday
      volume: 1,
    });
    const cs = [priorBreak, ...breakoutCandles([67_200, 67_300])];
    const currentOpen = dayStart + 10 * HOUR_MS;
    expect(hasPriorBreakout(cs, currentOpen, ARB_BREAKOUT_WINDOW, range)).toBe(false);
  });
});

describe("session constants are sane", () => {
  it("the four canonical windows don't overlap and are in chronological order", () => {
    const windows = [ASIAN_SESSION, ARB_BREAKOUT_WINDOW, PRE_NY_WINDOW, NY_BREAKOUT_WINDOW];
    for (let i = 1; i < windows.length; i++) {
      const prev = windows[i - 1]!;
      const cur = windows[i]!;
      expect(cur.startHour).toBeGreaterThan(prev.endHour);
    }
  });

  it("one full day has 24 hours and every session window has start ≤ end", () => {
    for (const w of [ASIAN_SESSION, ARB_BREAKOUT_WINDOW, PRE_NY_WINDOW, NY_BREAKOUT_WINDOW]) {
      expect(w.startHour).toBeLessThanOrEqual(w.endHour);
      expect(w.startHour).toBeGreaterThanOrEqual(0);
      expect(w.endHour).toBeLessThanOrEqual(23);
    }
    // Sanity: DAY_MS is used to cross-check conversion in other tests.
    expect(DAY_MS).toBe(24 * HOUR_MS);
  });
});
