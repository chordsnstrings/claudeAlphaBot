/**
 * Strategy C — Weekend Mean Reversion per spec §4.
 *
 * Fired exactly ONCE per week, at the Monday 00:00 UTC candle. Uses the
 * Friday close, weekend high/low, and Sunday close to detect outsized
 * weekend moves and fade them at the Monday open.
 *
 * Entry signal conditions:
 *   weekend_move_pct = (sunday_close − friday_close) / friday_close × 100
 *   if weekend_move_pct > +3.0 → SHORT (fade pump)
 *   if weekend_move_pct < −3.0 → LONG  (fade dump)
 *   else SKIP
 *   gap filter: |monday_open − sunday_close| / sunday_close > 1% → SKIP
 *
 * Exits:
 *   stop  (SHORT): weekend_high × 1.005
 *   stop  (LONG):  weekend_low  × 0.995
 *   tp1: 50% retrace (close 70%)
 *   tp2: friday_close (close 30%)
 *   breakeven at 1R
 *   time stop: Tuesday 08:00 UTC (32h after entry)
 */
import type { Candle, SignalIntent, Symbol as TradingSymbol } from "@hydra/shared";

export const DEFAULT_WMR_THRESHOLD_PCT = 3.0;
export const DEFAULT_WMR_GAP_FILTER_PCT = 1.0;
export const DEFAULT_WMR_STOP_BUFFER_PCT = 0.5;
export const DEFAULT_WMR_TP1_ALLOC_PCT = 70;
export const DEFAULT_WMR_BREAKEVEN_R = 1.0;
export const DEFAULT_WMR_TIME_STOP_HOURS = 32;

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

export interface WeekendMrOptions {
  readonly thresholdPct?: number;
  readonly gapFilterPct?: number;
  readonly stopBufferPct?: number;
  readonly tp1AllocationPct?: number;
  readonly breakevenRmultiple?: number;
  readonly timeStopHours?: number;
}

export interface WeekendMrInputs {
  readonly symbol: TradingSymbol;
  /** Candle history including the Monday 00:00 UTC candle (the candidate entry candle). */
  readonly candles: readonly Candle[];
  readonly hasExistingPosition: boolean;
  readonly opts?: WeekendMrOptions;
}

export type WeekendMrSkipReason =
  | "INSUFFICIENT_DATA"
  | "NOT_MONDAY_OPEN"
  | "FRIDAY_CLOSE_MISSING"
  | "SUNDAY_CLOSE_MISSING"
  | "WEEKEND_EXTREMES_MISSING"
  | "MOVE_TOO_SMALL"
  | "GAP_TOO_LARGE"
  | "EXISTING_POSITION";

export type WeekendMrDecision =
  | { readonly type: "FIRE"; readonly signal: SignalIntent }
  | { readonly type: "SKIP"; readonly reason: WeekendMrSkipReason; readonly detail?: string };

export function evaluateWeekendMr(inputs: WeekendMrInputs): WeekendMrDecision {
  const opts = inputs.opts ?? {};
  const threshold = opts.thresholdPct ?? DEFAULT_WMR_THRESHOLD_PCT;
  const gapFilter = opts.gapFilterPct ?? DEFAULT_WMR_GAP_FILTER_PCT;
  const stopBuffer = opts.stopBufferPct ?? DEFAULT_WMR_STOP_BUFFER_PCT;
  const tp1Alloc = opts.tp1AllocationPct ?? DEFAULT_WMR_TP1_ALLOC_PCT;
  const beR = opts.breakevenRmultiple ?? DEFAULT_WMR_BREAKEVEN_R;
  const timeStopHours = opts.timeStopHours ?? DEFAULT_WMR_TIME_STOP_HOURS;

  const candles = inputs.candles;
  if (candles.length === 0) return { type: "SKIP", reason: "INSUFFICIENT_DATA" };
  const current = candles[candles.length - 1];
  if (!current) return { type: "SKIP", reason: "INSUFFICIENT_DATA" };

  // Must be Monday 00:00 UTC.
  const d = new Date(current.openTime);
  if (d.getUTCDay() !== 1 || d.getUTCHours() !== 0) {
    return { type: "SKIP", reason: "NOT_MONDAY_OPEN" };
  }

  if (inputs.hasExistingPosition) {
    return { type: "SKIP", reason: "EXISTING_POSITION" };
  }

  // Friday 23:00 UTC candle (closes at 23:59:59.999) — close = friday_close.
  // Compute timestamps:
  const mondayOpen = current.openTime;
  const fridayCloseCandleOpen = mondayOpen - 49 * HOUR_MS; // Mon 00:00 − 49h = Sat 23:00 − no
  // Actually: Mon 00:00 − 24h = Sun 00:00; − 24h again = Sat 00:00; − 1h = Fri 23:00.
  const fridayLastCandleOpen = mondayOpen - 25 * HOUR_MS; // Fri 23:00 hourly bar
  const sundayLastCandleOpen = mondayOpen - HOUR_MS; // Sun 23:00 hourly bar

  // Index by openTime for fast lookup.
  const byTime = new Map<number, Candle>();
  for (const c of candles) byTime.set(c.openTime, c);

  const fridayLast = byTime.get(fridayLastCandleOpen);
  if (!fridayLast) return { type: "SKIP", reason: "FRIDAY_CLOSE_MISSING" };
  const sundayLast = byTime.get(sundayLastCandleOpen);
  if (!sundayLast) return { type: "SKIP", reason: "SUNDAY_CLOSE_MISSING" };

  const fridayClose = fridayLast.close;
  const sundayClose = sundayLast.close;

  // Weekend extremes: Saturday 00:00 through Sunday 23:00 inclusive (48 hourly bars).
  const weekendStart = mondayOpen - 48 * HOUR_MS; // Sat 00:00
  let weekendHigh = -Infinity;
  let weekendLow = Infinity;
  let weekendBars = 0;
  for (let t = weekendStart; t <= sundayLastCandleOpen; t += HOUR_MS) {
    const c = byTime.get(t);
    if (!c) continue;
    if (c.high > weekendHigh) weekendHigh = c.high;
    if (c.low < weekendLow) weekendLow = c.low;
    weekendBars++;
  }
  if (weekendBars === 0) return { type: "SKIP", reason: "WEEKEND_EXTREMES_MISSING" };

  if (fridayClose <= 0) return { type: "SKIP", reason: "FRIDAY_CLOSE_MISSING" };
  const movePct = ((sundayClose - fridayClose) / fridayClose) * 100;
  let direction: "LONG" | "SHORT" | null = null;
  if (movePct > threshold) direction = "SHORT";
  else if (movePct < -threshold) direction = "LONG";
  if (!direction) {
    return { type: "SKIP", reason: "MOVE_TOO_SMALL", detail: movePct.toFixed(3) };
  }

  const mondayOpenPrice = current.open;
  const gapPct = ((mondayOpenPrice - sundayClose) / sundayClose) * 100;
  if (Math.abs(gapPct) > gapFilter) {
    return { type: "SKIP", reason: "GAP_TOO_LARGE", detail: gapPct.toFixed(3) };
  }

  const entry = mondayOpenPrice;
  const stop =
    direction === "SHORT"
      ? weekendHigh * (1 + stopBuffer / 100)
      : weekendLow * (1 - stopBuffer / 100);
  const riskDistance = Math.abs(entry - stop);
  if (riskDistance <= 0) {
    return { type: "SKIP", reason: "INSUFFICIENT_DATA", detail: "zero_risk_distance" };
  }
  // Targets per spec §4.3
  // tp1 = friday_close + 0.5 × (sunday_close − friday_close)  = midpoint between friday_close & sunday_close
  const tp1 = fridayClose + 0.5 * (sundayClose - fridayClose);
  const tp2 = fridayClose;
  const breakeven =
    direction === "SHORT" ? entry - beR * riskDistance : entry + beR * riskDistance;
  const timeStopUtc = current.openTime + timeStopHours * HOUR_MS;

  const signal: SignalIntent = {
    strategy: "WEEKEND_MR",
    symbol: inputs.symbol,
    direction,
    generatedAt: current.closeTime,
    entryPrice: entry,
    stopPrice: stop,
    tp1Price: tp1,
    tp2Price: tp2,
    tp1AllocationPct: tp1Alloc,
    breakevenTriggerPrice: breakeven,
    timeStopUtc,
    reasoning:
      `WEEKEND_MR ${direction}: weekend move ${movePct.toFixed(2)}%, ` +
      `friday_close ${fridayClose}, sunday_close ${sundayClose}, ` +
      `weekend_extremes [${weekendLow}, ${weekendHigh}]`,
    meta: {
      fridayClose,
      sundayClose,
      weekendHigh,
      weekendLow,
      weekendMovePct: movePct,
      gapPct,
      riskDistance,
    },
  };
  return { type: "FIRE", signal };
}

/** Suppress unused-import for MIN_MS placeholder. */
void MIN_MS;
