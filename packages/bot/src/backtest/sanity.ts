/**
 * Backtest sanity checks per Phase 9 rubric:
 *   "CRITICAL CHECK: if return >100% or max DD <5% on 3 months → HALT,
 *    write SUSPICIOUS_RESULTS.md, do NOT proceed"
 *
 * Pure decision function — call it on any backtest report and act on the
 * returned `SuspiciousFinding[]`. The CLI wrapper that runs validation
 * is responsible for halting + writing SUSPICIOUS_RESULTS.md when the
 * list is non-empty.
 */
import type { SummaryMetrics } from "./metrics.js";

export const SUSPICIOUS_RETURN_PCT = 100;
export const SUSPICIOUS_MAX_DD_PCT = 5;

export type SuspiciousFindingKind = "RETURN_TOO_HIGH" | "DRAWDOWN_TOO_LOW";

export interface SuspiciousFinding {
  readonly kind: SuspiciousFindingKind;
  readonly observed: number;
  readonly threshold: number;
  readonly explanation: string;
}

export interface SanityOptions {
  /** Approximate length of the backtest in days. The thresholds in the spec
   * specifically reference "3 months" — for shorter runs, the same caps
   * still apply (small wins are fine; massive wins are still suspicious).
   * For runs significantly longer (>9mo), the return threshold should be
   * scaled — caller can pass a custom threshold via opts. */
  readonly returnPctThreshold?: number;
  readonly maxDrawdownPctThreshold?: number;
  /** Don't fire DRAWDOWN_TOO_LOW unless we've seen at least this many trades. */
  readonly minTradesForDdCheck?: number;
}

export function findSuspiciousResults(
  summary: SummaryMetrics,
  opts: SanityOptions = {},
): SuspiciousFinding[] {
  const returnCap = opts.returnPctThreshold ?? SUSPICIOUS_RETURN_PCT;
  const ddFloor = opts.maxDrawdownPctThreshold ?? SUSPICIOUS_MAX_DD_PCT;
  const minTrades = opts.minTradesForDdCheck ?? 20;

  const findings: SuspiciousFinding[] = [];
  if (summary.totalReturnPct > returnCap) {
    findings.push({
      kind: "RETURN_TOO_HIGH",
      observed: summary.totalReturnPct,
      threshold: returnCap,
      explanation:
        `Total return ${summary.totalReturnPct.toFixed(2)}% exceeds sanity cap ${returnCap}%. ` +
        `On 3 months of crypto perp data this almost always indicates a look-ahead bug, ` +
        `incorrect fee/slippage modelling, or accidental compounding error.`,
    });
  }
  if (summary.trades >= minTrades && summary.maxDrawdownPct < ddFloor) {
    findings.push({
      kind: "DRAWDOWN_TOO_LOW",
      observed: summary.maxDrawdownPct,
      threshold: ddFloor,
      explanation:
        `Max drawdown ${summary.maxDrawdownPct.toFixed(2)}% is below ${ddFloor}% with ${summary.trades} trades. ` +
        `Real strategies have stop-runs; sub-${ddFloor}% drawdowns over 3 months strongly suggest exits ` +
        `peeking at future bars or losses being absorbed silently.`,
    });
  }
  return findings;
}
