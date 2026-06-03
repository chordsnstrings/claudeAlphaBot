// blend.ts — combines regime + pool sleeves, vol-targets each, returns final target position.

import { Bar, Book } from "./types";
import { CONFIG } from "./config";
import { closes, stdDev, sma } from "./indicators";
import { regimePosition, regimePositionSeries } from "./regime";
import { poolNetPosition } from "./pool";

/** Causal trailing vol-target factor at the latest bar.
 * scale = clip(target / realized_vol, 0, cap), where realized_vol uses 30d trailing returns. */
function volTargetScale(returns: number[], targetAnn: number, cap: number, lb: number = 30): number {
  if (returns.length < lb + 1) return 0;
  const recent = returns.slice(-lb - 1, -1); // shift(1) — causal
  const std = stdDev(recent, lb);
  const lastStd = std[std.length - 1];
  if (isNaN(lastStd) || lastStd <= 0) return 0;
  const annVol = lastStd * Math.sqrt(365);
  const scale = Math.min(targetAnn / annVol, cap);
  return Math.max(0, scale);
}

/** Daily returns from a position series + bar returns. */
function dailyReturnsFromPosition(positions: number[], bars: Bar[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (i - 1 >= positions.length) break;
    const ret = bars[i].close / bars[i - 1].close - 1;
    const pos = positions[i - 1];
    returns.push((isNaN(pos) ? 0 : pos) * ret);
  }
  return returns;
}

/**
 * Compute the FINAL blended target position (as fraction of equity) at the latest bar.
 * Returns position in roughly [-cap*W, +cap*W] (i.e., [-1.5, +1.5] at default cap=1.5).
 */
export function computeBlendTarget(
  dailyBars: Bar[],
  poolPositionToday: number,        // current net pool position (sum of open books / equity)
  recentRegimeReturns: number[],    // regime sleeve daily returns (for vol-target)
  recentPoolReturns: number[],      // pool sleeve daily returns (for vol-target)
): {
  regimePos: number;
  poolPos: number;
  regimeScale: number;
  poolScale: number;
  blendedTarget: number;
} {
  const regimePos = regimePosition(dailyBars);
  const poolPos = poolPositionToday;

  const regimeScale = volTargetScale(
    recentRegimeReturns,
    CONFIG.VOL_TARGET,
    CONFIG.LEV_CAP,
    30,
  );
  const poolScale = volTargetScale(recentPoolReturns, CONFIG.VOL_TARGET, CONFIG.LEV_CAP, 30);

  const blendedTarget =
    CONFIG.W_REGIME * regimeScale * regimePos +
    CONFIG.W_POOL * poolScale * poolPos;

  return {
    regimePos,
    poolPos,
    regimeScale,
    poolScale,
    blendedTarget: blendedTarget * CONFIG.LEVERAGE_MULT, // optional aggressive multiplier
  };
}

/** Compute historical pool daily returns from open/closed books, for vol-targeting.
 * For a simple bot, we approximate via the cumulative net position * price changes. */
export function approxPoolDailyReturns(
  poolPositionsByDay: number[], // average pool net position per day
  dailyBars: Bar[],
): number[] {
  const returns: number[] = [];
  for (let i = 1; i < dailyBars.length && i < poolPositionsByDay.length; i++) {
    const r = dailyBars[i].close / dailyBars[i - 1].close - 1;
    const p = poolPositionsByDay[i - 1];
    returns.push((isNaN(p) ? 0 : p) * r);
  }
  return returns;
}

/** Quick approximation: use the regime sleeve daily returns for vol-target estimation,
 * based on its position series and daily price changes. */
export function regimeDailyReturns(dailyBars: Bar[]): number[] {
  const positions = regimePositionSeries(dailyBars);
  return dailyReturnsFromPosition(positions, dailyBars);
}
