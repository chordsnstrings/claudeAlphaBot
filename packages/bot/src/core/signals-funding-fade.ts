/**
 * Strategy D — Funding Settlement Fade per spec §5.
 *
 * Fired at the +30-minute mark after each funding settlement (00:00, 08:00,
 * 16:00 UTC). Requires:
 *   - |funding_rate| ≥ 0.05% (0.0005)
 *   - 30 min later, price has moved 0.2%+ in our favor (positive funding →
 *     SHORT, so price should have dropped 0.2%+; negative funding → LONG)
 *   - account equity ≥ $3,000 (gate parameter)
 *   - max 3 fires per symbol per UTC day from this strategy
 *
 * Exits: fixed 0.8% stop, fixed 1.5% target, breakeven at +0.8%, time stop at
 * the next funding settlement (8h after entry).
 *
 * NOTE: this is the only strategy that needs explicit per-symbol counters and
 * a funding-rate context object. The caller (replay engine / live scheduler)
 * is responsible for tracking the daily fire count and passing it in.
 */
import type { Candle, FundingRate, SignalIntent, Symbol as TradingSymbol } from "@hydra/shared";

export const DEFAULT_FF_MIN_ABS_FUNDING = 0.0005;
export const DEFAULT_FF_CONFIRMATION_PCT = 0.2;
export const DEFAULT_FF_CONFIRMATION_DELAY_MIN = 30;
export const DEFAULT_FF_STOP_PCT = 0.8;
export const DEFAULT_FF_TARGET_PCT = 1.5;
export const DEFAULT_FF_BREAKEVEN_PCT = 0.8;
export const DEFAULT_FF_TIME_STOP_HOURS = 8;
export const DEFAULT_FF_MIN_EQUITY_USD = 3_000;
export const DEFAULT_FF_MAX_TRADES_PER_DAY = 3;

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

export interface FundingFadeOptions {
  readonly minAbsFunding?: number;
  readonly confirmationPct?: number;
  readonly confirmationDelayMin?: number;
  readonly stopPct?: number;
  readonly targetPct?: number;
  readonly breakevenPct?: number;
  readonly timeStopHours?: number;
  readonly minEquityUsd?: number;
  readonly maxTradesPerDay?: number;
}

export interface FundingFadeInputs {
  readonly symbol: TradingSymbol;
  /** Candle history including the +30-min confirmation candle. The most recent
   * candle's openTime should be the confirmation candle (e.g., 00:30 UTC). For
   * 1-hour bars there is no exact 00:30 candle — the engine should call this
   * function on the candle whose openTime is the settlement hour itself, and
   * pass `confirmationPriceOverride` derived from sub-hour data, OR call on
   * the candle whose openTime == settlement + 1h and use that bar's open as
   * proxy for the +30-min mark. We accept either via the optional override. */
  readonly candles: readonly Candle[];
  /** Optional explicit confirmation price (e.g., from a 1m candle at +30min). */
  readonly confirmationPriceOverride?: number;
  /** All known funding rates (we match the most recent settlement at or before nowUtc). */
  readonly fundingHistory: readonly FundingRate[];
  readonly nowUtc: number; // wall-clock at which the signal is being evaluated
  readonly accountEquity: number;
  readonly tradesToday: number;
  readonly hasExistingPosition: boolean;
  readonly opts?: FundingFadeOptions;
}

export type FundingFadeSkipReason =
  | "INSUFFICIENT_DATA"
  | "EQUITY_TOO_LOW"
  | "MAX_DAILY_TRADES"
  | "EXISTING_POSITION"
  | "NO_RECENT_SETTLEMENT"
  | "FUNDING_TOO_SMALL"
  | "NO_CONFIRMATION_CANDLE"
  | "CONFIRMATION_INSUFFICIENT";

export type FundingFadeDecision =
  | { readonly type: "FIRE"; readonly signal: SignalIntent }
  | { readonly type: "SKIP"; readonly reason: FundingFadeSkipReason; readonly detail?: string };

export function evaluateFundingFade(inputs: FundingFadeInputs): FundingFadeDecision {
  const opts = inputs.opts ?? {};
  const minFunding = opts.minAbsFunding ?? DEFAULT_FF_MIN_ABS_FUNDING;
  const confPct = opts.confirmationPct ?? DEFAULT_FF_CONFIRMATION_PCT;
  const confDelayMin = opts.confirmationDelayMin ?? DEFAULT_FF_CONFIRMATION_DELAY_MIN;
  const stopPct = opts.stopPct ?? DEFAULT_FF_STOP_PCT;
  const targetPct = opts.targetPct ?? DEFAULT_FF_TARGET_PCT;
  const beTriggerPct = opts.breakevenPct ?? DEFAULT_FF_BREAKEVEN_PCT;
  const timeStopHours = opts.timeStopHours ?? DEFAULT_FF_TIME_STOP_HOURS;
  const minEquity = opts.minEquityUsd ?? DEFAULT_FF_MIN_EQUITY_USD;
  const maxPerDay = opts.maxTradesPerDay ?? DEFAULT_FF_MAX_TRADES_PER_DAY;

  if (inputs.accountEquity < minEquity) {
    return { type: "SKIP", reason: "EQUITY_TOO_LOW", detail: inputs.accountEquity.toFixed(2) };
  }
  if (inputs.tradesToday >= maxPerDay) {
    return { type: "SKIP", reason: "MAX_DAILY_TRADES" };
  }
  if (inputs.hasExistingPosition) {
    return { type: "SKIP", reason: "EXISTING_POSITION" };
  }

  // Find the most recent settlement at or before (nowUtc − confDelayMin*MIN_MS).
  // We need confDelayMin minutes between settlement and now.
  const settlementCutoff = inputs.nowUtc - confDelayMin * MIN_MS;
  let lastSettlement: FundingRate | null = null;
  for (let i = inputs.fundingHistory.length - 1; i >= 0; i--) {
    const f = inputs.fundingHistory[i]!;
    if (f.symbol !== inputs.symbol) continue;
    if (f.fundingTime <= settlementCutoff) {
      lastSettlement = f;
      break;
    }
  }
  if (!lastSettlement) {
    return { type: "SKIP", reason: "NO_RECENT_SETTLEMENT" };
  }
  // Must be within (now - 8h, settlementCutoff] — don't fire on stale settlements.
  if (lastSettlement.fundingTime <= inputs.nowUtc - timeStopHours * HOUR_MS) {
    return { type: "SKIP", reason: "NO_RECENT_SETTLEMENT", detail: "stale" };
  }

  if (Math.abs(lastSettlement.fundingRate) < minFunding) {
    return {
      type: "SKIP",
      reason: "FUNDING_TOO_SMALL",
      detail: lastSettlement.fundingRate.toFixed(6),
    };
  }
  const direction: "LONG" | "SHORT" = lastSettlement.fundingRate > 0 ? "SHORT" : "LONG";

  // Find settlement-time price (open of the candle whose openTime == settlement)
  // and confirmation price (override OR latest candle close).
  const candles = inputs.candles;
  if (candles.length === 0) return { type: "SKIP", reason: "INSUFFICIENT_DATA" };
  const settlementCandle = candles.find((c) => c.openTime === lastSettlement!.fundingTime);
  if (!settlementCandle) return { type: "SKIP", reason: "INSUFFICIENT_DATA", detail: "no_settlement_candle" };

  const settlementPrice = settlementCandle.open;
  const confirmationPrice = inputs.confirmationPriceOverride ?? candles[candles.length - 1]!.close;
  if (!Number.isFinite(confirmationPrice) || confirmationPrice <= 0) {
    return { type: "SKIP", reason: "NO_CONFIRMATION_CANDLE" };
  }

  const movePct = ((confirmationPrice - settlementPrice) / settlementPrice) * 100;
  // SHORT signal needs price to drop ≥ confPct%; LONG needs price to rise ≥ confPct%.
  if (direction === "SHORT" && movePct > -confPct) {
    return { type: "SKIP", reason: "CONFIRMATION_INSUFFICIENT", detail: movePct.toFixed(3) };
  }
  if (direction === "LONG" && movePct < confPct) {
    return { type: "SKIP", reason: "CONFIRMATION_INSUFFICIENT", detail: movePct.toFixed(3) };
  }

  const entry = confirmationPrice;
  const stop = direction === "LONG" ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100);
  const target = direction === "LONG" ? entry * (1 + targetPct / 100) : entry * (1 - targetPct / 100);
  const breakeven =
    direction === "LONG"
      ? entry * (1 + beTriggerPct / 100)
      : entry * (1 - beTriggerPct / 100);
  const timeStopUtc = lastSettlement.fundingTime + timeStopHours * HOUR_MS;

  const signal: SignalIntent = {
    strategy: "FUNDING_FADE",
    symbol: inputs.symbol,
    direction,
    generatedAt: inputs.nowUtc,
    entryPrice: entry,
    stopPrice: stop,
    tp1Price: target, // single target — TP1 = TP2 = full close.
    tp2Price: target,
    tp1AllocationPct: 100, // close 100% at target (no scaling)
    breakevenTriggerPrice: breakeven,
    timeStopUtc,
    reasoning:
      `FUNDING_FADE ${direction}: funding ${(lastSettlement.fundingRate * 100).toFixed(4)}%, ` +
      `+${confDelayMin}min confirmation move ${movePct.toFixed(3)}%`,
    meta: {
      fundingRate: lastSettlement.fundingRate,
      settlementTime: lastSettlement.fundingTime,
      settlementPrice,
      confirmationPrice,
      confirmationMovePct: movePct,
    },
  };
  return { type: "FIRE", signal };
}
