/**
 * Regime classifier — spec §11.3 (LOCKED, NOT TUNABLE).
 *
 *   inputs: ADX(14), ATR percentile (60d), close vs SMA200
 *   if atrPercentile > 0.80: regime = 'volatile'
 *   elif adx14 > 25 and close > sma200: regime = 'trending'
 *   elif adx14 < 20 and atrPercentile < 0.50: regime = 'ranging'
 *   else: regime = 'mixed'
 *
 * Allocation per regime (also locked):
 *   trending: trend=60% meanRev=15% breakout=25%
 *   ranging:  trend=15% meanRev=60% breakout=25%
 *   volatile: trend=25% meanRev=15% breakout=60%
 *   mixed:    trend=33.3% meanRev=33.3% breakout=33.3%
 */

export type Regime = "trending" | "ranging" | "volatile" | "mixed";

export type StrategyCategory = "trend" | "meanRev" | "breakout";

export interface RegimeInputs {
  adx14: number;
  atrPercentile60: number;
  close: number;
  sma200: number;
}

export function classifyRegime(inputs: RegimeInputs): Regime {
  if (inputs.atrPercentile60 > 0.8) {
    return "volatile";
  }
  if (inputs.adx14 > 25 && inputs.close > inputs.sma200) {
    return "trending";
  }
  if (inputs.adx14 < 20 && inputs.atrPercentile60 < 0.5) {
    return "ranging";
  }
  return "mixed";
}

const ONE_THIRD = 1 / 3;

export const REGIME_ALLOCATIONS: Record<Regime, Record<StrategyCategory, number>> = {
  trending: { trend: 0.6, meanRev: 0.15, breakout: 0.25 },
  ranging: { trend: 0.15, meanRev: 0.6, breakout: 0.25 },
  volatile: { trend: 0.25, meanRev: 0.15, breakout: 0.6 },
  mixed: { trend: ONE_THIRD, meanRev: ONE_THIRD, breakout: ONE_THIRD },
};
