/**
 * Commission per spec §6.7 — Pepperstone Razor $7 per round-turn
 * standard lot. We charge half ($3.50) on entry and half on exit so the
 * accounting matches Pepperstone's MT5 reporting.
 */

import {
  PEPPERSTONE_COMMISSION_PER_RT_LOT_USD,
  commissionMultiplier,
  type FrictionProfileName,
} from "./profiles.js";

export function commissionUsd(
  lotSize: number,
  profile: FrictionProfileName,
  side: "entry" | "exit" | "round_turn" = "round_turn",
): number {
  const mult = commissionMultiplier(profile);
  const rt = PEPPERSTONE_COMMISSION_PER_RT_LOT_USD * lotSize * mult;
  if (side === "round_turn") {
    return rt;
  }
  return rt / 2;
}
