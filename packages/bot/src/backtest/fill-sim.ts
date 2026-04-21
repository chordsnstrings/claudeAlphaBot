/**
 * Order fill simulation per spec §8.4.
 *
 * Pure functions — given a candle and an open position, return either
 * {kind:"NO_FILL"} or one or more `Fill` events describing how the position
 * was filled / partially filled / closed during that candle.
 *
 * Fee + slippage model (spec §8.4):
 *   - Entry: candle close × (1 ± slippage). Fee = notional × taker_rate.
 *   - Slippage = 2 bps (0.0002) per side.
 *   - Taker fee = 0.04% (0.0004) per side.
 *
 * Conservative ordering when both STOP and TP touched in one candle:
 *   - Spec §8.4 worst-case rule: STOP wins.
 *
 * Multi-stage exit:
 *   - When a position has TP1 not yet filled and the candle reaches TP1
 *     but not the stop, return one fill: 50% at TP1, remainder lives on.
 *   - On subsequent candles, the breakeven stop is at entry price (caller
 *     must update `position.stopPrice` after a TP1 fill).
 */
import type { Candle, Direction, ExitReason } from "@hydra/shared";

export const DEFAULT_SLIPPAGE_BPS = 0.0002;
export const DEFAULT_TAKER_FEE = 0.0004;

export interface FeeOptions {
  /** Fractional slippage per side, e.g. 0.0002 = 2 bps. */
  readonly slippage?: number;
  /** Fractional taker fee per side, e.g. 0.0004 = 0.04%. */
  readonly takerFee?: number;
}

/** Simulated entry fill: price after slippage + fee deducted from cash. */
export interface EntryFillResult {
  readonly entryPrice: number;
  readonly feePaid: number;
}

/**
 * Apply slippage + fee to an entry. The intended entry price (the candle
 * close, in spec terms) is bumped against the trader.
 */
export function simulateEntryFill(
  intendedPrice: number,
  quantity: number,
  direction: Direction,
  opts: FeeOptions = {},
): EntryFillResult {
  const slip = opts.slippage ?? DEFAULT_SLIPPAGE_BPS;
  const fee = opts.takerFee ?? DEFAULT_TAKER_FEE;
  const factor = direction === "LONG" ? 1 + slip : 1 - slip;
  const entryPrice = intendedPrice * factor;
  const feePaid = entryPrice * quantity * fee;
  return { entryPrice, feePaid };
}

/** A position passed into the exit simulator (subset of OpenPosition fields). */
export interface ExitPositionInput {
  readonly direction: Direction;
  readonly entryPrice: number;
  readonly stopPrice: number;
  readonly tp1Price: number;
  readonly tp2Price: number;
  readonly remainingQuantity: number;
  readonly tp1Filled: boolean;
  readonly timeStopUtc: number;
}

export interface ExitFill {
  readonly kind: "EXIT";
  readonly exitReason: ExitReason;
  readonly exitPrice: number; // after slippage
  readonly closeQuantity: number;
  readonly feePaid: number;
  /** True if the position is fully closed; false if partial (TP1). */
  readonly fullyClosed: boolean;
}

export type ExitDecision = { readonly kind: "NO_FILL" } | ExitFill;

/**
 * Simulate the exit logic for `position` against ONE candle.
 *
 * Order of checks (spec §8.4):
 *   1. STOP touched (low ≤ stop for LONG / high ≥ stop for SHORT).
 *   2. If candle.openTime ≥ timeStopUtc → close at candle close (TIME_STOP).
 *   3. TP2 touched (full close).
 *   4. TP1 touched (50% close, remainder stays open).
 *
 * If both stop and TP touched in same candle: STOP wins (rule §8.4 critical).
 *
 * Returns NO_FILL if nothing triggers.
 */
export function simulateExitForCandle(
  position: ExitPositionInput,
  candle: Candle,
  opts: FeeOptions = {},
): ExitDecision {
  const slip = opts.slippage ?? DEFAULT_SLIPPAGE_BPS;
  const fee = opts.takerFee ?? DEFAULT_TAKER_FEE;
  const dir = position.direction;
  const qty = position.remainingQuantity;

  const stopHit =
    dir === "LONG" ? candle.low <= position.stopPrice : candle.high >= position.stopPrice;
  const tp1Hit =
    dir === "LONG"
      ? candle.high >= position.tp1Price
      : candle.low <= position.tp1Price;
  const tp2Hit =
    dir === "LONG"
      ? candle.high >= position.tp2Price
      : candle.low <= position.tp2Price;

  // 1. STOP wins on collisions (worst-case fill assumption).
  if (stopHit) {
    const exitPrice =
      dir === "LONG" ? position.stopPrice * (1 - slip) : position.stopPrice * (1 + slip);
    return {
      kind: "EXIT",
      exitReason: "STOP",
      exitPrice,
      closeQuantity: qty,
      feePaid: exitPrice * qty * fee,
      fullyClosed: true,
    };
  }

  // 2. Time stop: candle whose openTime is ≥ timeStop closes at this candle's close.
  if (candle.openTime >= position.timeStopUtc) {
    const exitPrice = candle.close * (dir === "LONG" ? 1 - slip : 1 + slip);
    return {
      kind: "EXIT",
      exitReason: "TIME_STOP",
      exitPrice,
      closeQuantity: qty,
      feePaid: exitPrice * qty * fee,
      fullyClosed: true,
    };
  }

  // 3. TP2 (full close). If TP1 not yet hit, still close all here.
  if (tp2Hit) {
    const exitPrice =
      dir === "LONG" ? position.tp2Price * (1 - slip) : position.tp2Price * (1 + slip);
    return {
      kind: "EXIT",
      exitReason: "TP2",
      exitPrice,
      closeQuantity: qty,
      feePaid: exitPrice * qty * fee,
      fullyClosed: true,
    };
  }

  // 4. TP1 (50% close, only if TP1 not yet filled).
  if (!position.tp1Filled && tp1Hit) {
    const closeQty = qty * 0.5;
    const exitPrice =
      dir === "LONG" ? position.tp1Price * (1 - slip) : position.tp1Price * (1 + slip);
    return {
      kind: "EXIT",
      exitReason: "TP1",
      exitPrice,
      closeQuantity: closeQty,
      feePaid: exitPrice * closeQty * fee,
      fullyClosed: false,
    };
  }

  return { kind: "NO_FILL" };
}

/**
 * Compute the funding payment owed BY a position over a given funding settlement.
 * Returns positive = position pays out (P&L decrease), negative = position receives.
 */
export function fundingPayment(params: {
  readonly direction: Direction;
  readonly notionalUsd: number;
  readonly fundingRate: number; // signed decimal e.g. +0.0001
}): number {
  // LONG pays when funding_rate > 0; receives when < 0. SHORT inverse.
  const sign = params.direction === "LONG" ? 1 : -1;
  return sign * params.notionalUsd * params.fundingRate;
}
