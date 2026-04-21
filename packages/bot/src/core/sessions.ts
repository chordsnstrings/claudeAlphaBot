/**
 * Session utilities for session-based strategies (spec §2.2, §3.2).
 *
 * All windows are defined in UTC and inclusive on both hour endpoints
 * against the candle's `openTime`. For a 1-hour candle with openTime at
 * H:00, "candle is in window [S, E]" ⇔ S ≤ H ≤ E.
 *
 *   ASIAN_SESSION       : 00:00–06:59 UTC (7 candles) — Strategy A range
 *   ARB_BREAKOUT_WINDOW : 07:00–10:59 UTC (4 candles) — Strategy A entry
 *   PRE_NY_WINDOW       : 11:00–12:59 UTC (2 candles) — Strategy B range
 *   NY_BREAKOUT_WINDOW  : 13:00–14:59 UTC (2 candles) — Strategy B entry
 *
 * The scheduler and strategy modules work in epoch-ms throughout. These
 * helpers keep that assumption by operating on `Candle.openTime` and the
 * standardized `YYYY-MM-DD` UTC date key.
 */
import type { Candle } from "@hydra/shared";

export interface HourRange {
  /** Inclusive start hour [0..23]. */
  readonly startHour: number;
  /** Inclusive end hour [0..23]. */
  readonly endHour: number;
}

export const ASIAN_SESSION: HourRange = { startHour: 0, endHour: 6 };
export const ARB_BREAKOUT_WINDOW: HourRange = { startHour: 7, endHour: 10 };
export const PRE_NY_WINDOW: HourRange = { startHour: 11, endHour: 12 };
export const NY_BREAKOUT_WINDOW: HourRange = { startHour: 13, endHour: 14 };

export interface SessionRange {
  readonly dateKey: string;
  readonly high: number;
  readonly low: number;
  readonly open: number;
  readonly close: number;
  readonly totalVolume: number;
  readonly candleCount: number;
  readonly firstOpenTime: number;
  readonly lastOpenTime: number;
}

const HOUR_MS = 3_600_000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** YYYY-MM-DD UTC date key from an epoch-ms timestamp. */
export function utcDateKey(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Epoch-ms at 00:00:00 UTC for a YYYY-MM-DD key.
 * Throws on malformed or non-existent dates (e.g. 2024-02-30).
 */
export function startOfUtcDay(dateKey: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) throw new Error(`invalid date key: ${dateKey}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const round = new Date(ms);
  if (
    round.getUTCFullYear() !== year ||
    round.getUTCMonth() !== month - 1 ||
    round.getUTCDate() !== day
  ) {
    throw new Error(`invalid date key: ${dateKey}`);
  }
  return ms;
}

/** Epoch-ms at the top of `hour` on the given UTC date. */
export function utcHourStart(dateKey: string, hour: number): number {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`hour out of range: ${hour}`);
  }
  return startOfUtcDay(dateKey) + hour * HOUR_MS;
}

/** True if the UTC day-of-week at `epochMs` is Saturday or Sunday. */
export function isUtcWeekend(epochMs: number): boolean {
  const dow = new Date(epochMs).getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * True iff the candle's `openTime` falls within `[startHour, endHour]`
 * (inclusive) on the UTC day identified by `dateKey`.
 */
export function candleInWindow(candle: Candle, dateKey: string, window: HourRange): boolean {
  const dayStart = startOfUtcDay(dateKey);
  const winStart = dayStart + window.startHour * HOUR_MS;
  const winEndExclusive = dayStart + (window.endHour + 1) * HOUR_MS;
  return candle.openTime >= winStart && candle.openTime < winEndExclusive;
}

/** All candles whose openTime falls inside `window` on `dateKey`. */
export function candlesInWindow(
  candles: readonly Candle[],
  dateKey: string,
  window: HourRange,
): Candle[] {
  return candles.filter((c) => candleInWindow(c, dateKey, window));
}

/** Reduce a candle slice to a SessionRange. Assumes oldest → newest order. */
export function buildRangeFromCandles(
  dateKey: string,
  slice: readonly Candle[],
): SessionRange | null {
  if (slice.length === 0) return null;
  const first = slice[0];
  const last = slice[slice.length - 1];
  if (!first || !last) return null;
  let high = first.high;
  let low = first.low;
  let totalVolume = 0;
  for (const c of slice) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
    totalVolume += c.volume;
  }
  return {
    dateKey,
    high,
    low,
    open: first.open,
    close: last.close,
    totalVolume,
    candleCount: slice.length,
    firstOpenTime: first.openTime,
    lastOpenTime: last.openTime,
  };
}

/** Aggregate the candles in `window` on `dateKey` into a SessionRange. */
export function sessionRange(
  candles: readonly Candle[],
  dateKey: string,
  window: HourRange,
): SessionRange | null {
  return buildRangeFromCandles(dateKey, candlesInWindow(candles, dateKey, window));
}

/** Asian session (00:00-06:59 UTC) range on `dateKey`. */
export function asianSessionRange(
  candles: readonly Candle[],
  dateKey: string,
): SessionRange | null {
  return sessionRange(candles, dateKey, ASIAN_SESSION);
}

/** Pre-NY window (11:00-12:59 UTC) range on `dateKey`. */
export function preNyRange(
  candles: readonly Candle[],
  dateKey: string,
): SessionRange | null {
  return sessionRange(candles, dateKey, PRE_NY_WINDOW);
}

/**
 * Returns true if ANY candle strictly earlier than `currentOpenTime`,
 * within the breakout `window` on the UTC day of `currentOpenTime`,
 * already closed beyond `range`.
 *
 * Used by Strategy A and Strategy B for "first breakout only" filtering
 * (spec §2.2 Step 5 / §3.2 Step 5): we want to enter on the first close
 * outside the reference range, never a re-break.
 *
 * Assumes `candles` are ordered oldest → newest.
 */
export function hasPriorBreakout(
  candles: readonly Candle[],
  currentOpenTime: number,
  window: HourRange,
  range: { readonly high: number; readonly low: number },
): boolean {
  const dateKey = utcDateKey(currentOpenTime);
  for (const c of candles) {
    if (c.openTime >= currentOpenTime) break;
    if (!candleInWindow(c, dateKey, window)) continue;
    if (c.close > range.high || c.close < range.low) return true;
  }
  return false;
}
