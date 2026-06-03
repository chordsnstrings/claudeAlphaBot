// harvest.ts — wallet management with profit harvesting

import { StrategyState } from "./types";
import { CONFIG } from "./config";

/** Apply harvest rule. Mutates state.
 * Rule: if walletUsd > peak * (1 - decay) -> wallet has dropped 15% from peak; if wallet > base,
 *   harvest (wallet - base) to spotUsd, reset wallet to base.
 * Also: at calendar year-end, if wallet > base, harvest excess.
 */
export function harvestIfNeeded(
  state: StrategyState,
  nowMs: number,
  prevNowMs: number,
): { harvested: number; reason: string } {
  // Update peak
  if (state.walletUsd > state.walletPeak) state.walletPeak = state.walletUsd;

  // ATH-decay rule
  if (
    state.walletUsd > state.baseUsd &&
    state.walletUsd < state.walletPeak * (1 - CONFIG.HARVEST_DECAY)
  ) {
    const harvested = state.walletUsd - state.baseUsd;
    state.spotUsd += harvested;
    state.walletUsd = state.baseUsd;
    state.walletPeak = state.baseUsd;
    return { harvested, reason: `ATH-decay (${(CONFIG.HARVEST_DECAY * 100).toFixed(0)}%)` };
  }

  // Year-end rule
  const prevYear = new Date(prevNowMs).getUTCFullYear();
  const curYear = new Date(nowMs).getUTCFullYear();
  if (curYear !== prevYear && state.walletUsd > state.baseUsd) {
    const harvested = state.walletUsd - state.baseUsd;
    state.spotUsd += harvested;
    state.walletUsd = state.baseUsd;
    state.walletPeak = state.baseUsd;
    return { harvested, reason: "year-end sweep" };
  }

  return { harvested: 0, reason: "" };
}

/** Apply a return to the wallet. */
export function applyReturn(state: StrategyState, returnFrac: number): number {
  const delta = state.walletUsd * returnFrac;
  state.walletUsd += delta;
  return delta;
}

export function totalWealth(state: StrategyState): number {
  return state.walletUsd + state.spotUsd;
}
