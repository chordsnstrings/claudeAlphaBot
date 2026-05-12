/**
 * Swap (overnight carry) per spec §6.8.
 *
 *   Per standard lot per night USD, from a per-instrument table.
 *   Triple swap rolls over Wednesday 22:00 UTC (Friday's value for
 *   Wednesday-night carry).
 *
 * The simulated execution adapter calls `swapForNight()` once per
 * UTC-day rollover for each open position.
 */

import type { Direction } from "@trading/core";

import {
  swapParamsFor,
  swapValueForDirection,
  type FrictionProfileName,
} from "./profiles.js";

/** Wednesday rollover triples the carry; spec §6.8. */
export function isTripleSwapWednesday(rolloverUtc: Date): boolean {
  // Pepperstone rolls swaps at 22:00 UTC. The Wednesday rollover is the
  // 22:00 UTC instant on Wednesday — corresponding to the Friday-night
  // value being applied. Test that the UTC weekday is 3 (Wednesday) and
  // the hour is at/after rollover.
  return rolloverUtc.getUTCDay() === 3 && rolloverUtc.getUTCHours() >= 22;
}

export interface SwapForNightArgs {
  instrument: string;
  direction: Direction;
  lotSize: number;
  /** Rollover instant (typically 22:00 UTC on the night the position is held). */
  rolloverUtc: Date;
  profile: FrictionProfileName;
}

/** Returns the swap USD applied this night for the given position. */
export function swapForNight(args: SwapForNightArgs): number {
  const params = swapParamsFor(args.instrument, args.profile);
  const base = swapValueForDirection(params, args.direction);
  const factor = isTripleSwapWednesday(args.rolloverUtc) ? 3 : 1;
  return base * args.lotSize * factor;
}
