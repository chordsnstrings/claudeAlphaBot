/**
 * RiskConfig — all values are percentages of account equity (not dollars).
 * Spec §4.4 listing.
 */

export interface RiskConfig {
  riskPerTradePct: number;
  maxTotalOpenRiskPct: number;
  maxCorrelatedClusterPct: number;
  maxMarginUtilizationPct: number;
  dailyLossLimitPct: number;
  weeklySoftAlertPct: number;
  weeklyHardHaltPct: number;
  monthlySoftAlertPct: number;
  monthlyHardHaltPct: number;
  drawdownSoftReducePct: number;
  drawdownEmergencyStopPct: number;
  drawdownRebuildRequiredPct: number;
}

/** Spec §4.4 defaults; suitable for a $100k starting equity. */
export const DEFAULT_RISK_CONFIG: RiskConfig = {
  riskPerTradePct: 1.5,
  maxTotalOpenRiskPct: 6.0,
  maxCorrelatedClusterPct: 4.0,
  maxMarginUtilizationPct: 25.0,
  dailyLossLimitPct: 4.0,
  weeklySoftAlertPct: 6.0,
  weeklyHardHaltPct: 12.0,
  monthlySoftAlertPct: 8.0,
  monthlyHardHaltPct: 15.0,
  drawdownSoftReducePct: 10.0,
  drawdownEmergencyStopPct: 20.0,
  drawdownRebuildRequiredPct: 25.0,
};
