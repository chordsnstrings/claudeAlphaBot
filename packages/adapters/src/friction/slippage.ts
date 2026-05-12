/**
 * Slippage sampling per spec §6.6.
 *
 *   normalized_atr = clamp(current_atr14 / median_atr14_60d, 0.1, 5.0)
 *   stop  order: base = 0.3 + 0.5 * normalized_atr
 *   other order: base = 0.1 + 0.2 * normalized_atr
 *   news window: slippage = base * (3 + uniform(0, 10))
 *   normal     : slippage = base
 *
 * Direction is always cost-side (long entry fills above mid, exit below
 * mid; mirrored for short) — `applySlippage()` returns the signed price
 * adjustment in pips that already moves against the position.
 */

import type { Direction, OrderType } from "@trading/core";

import { slippageMultiplier, type FrictionProfileName } from "./profiles.js";
import type { SeededRng } from "./rng.js";

export interface SampleSlippageArgs {
  orderType: OrderType;
  isInNewsWindow: boolean;
  /** ATR(14) at the bar; pass null for first-bar warmup. */
  atr14: number | null;
  /** Median ATR(14) over the trailing 60 bars; null when warming up. */
  medianAtr14_60d: number | null;
  rng: SeededRng;
  profile: FrictionProfileName;
}

/** Slippage magnitude in pips (always >= 0). */
export function sampleSlippagePips(args: SampleSlippageArgs): number {
  const mult = slippageMultiplier(args.profile);
  if (mult === 0) {
    return 0;
  }
  let normalized = 1.0;
  if (args.atr14 !== null && args.medianAtr14_60d !== null && args.medianAtr14_60d > 0) {
    const raw = args.atr14 / args.medianAtr14_60d;
    normalized = Math.max(0.1, Math.min(5.0, raw));
  }
  const base =
    args.orderType === "stop"
      ? 0.3 + 0.5 * normalized
      : 0.1 + 0.2 * normalized;
  const adjusted = args.isInNewsWindow ? base * (3 + args.rng.nextRange(0, 10)) : base;
  return adjusted * mult;
}

/**
 * Apply a slippage of `pips` to `rawPrice` in the cost direction for the
 * given order side. Long entries fill above mid; long exits below; short
 * entries below; short exits above. Pip size must be passed in price units
 * (e.g. 0.0001 for EURUSD).
 */
export function applySlippage(
  rawPrice: number,
  pips: number,
  pipSize: number,
  direction: Direction,
  side: "entry" | "exit",
): number {
  const cost = pips * pipSize;
  if (side === "entry") {
    return direction === "long" ? rawPrice + cost : rawPrice - cost;
  }
  return direction === "long" ? rawPrice - cost : rawPrice + cost;
}
