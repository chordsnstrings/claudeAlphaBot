/**
 * Monthly profit-withdrawal ("skim") policy for the backtest engine.
 *
 * Models an operator who keeps a constant working capital and pulls every
 * dollar of realized profit out of the account at each UTC month boundary.
 * Because profit is removed rather than compounded, position sizing (which
 * keys off live equity in the replay engine) stays anchored to the base —
 * exactly the constant-stake behaviour a "take the extra out each month"
 * rule implies. The sum of withdrawals is the strategy's realized yield.
 */

export type WithdrawalPolicy =
  | { readonly kind: "none" }
  /** At each month rollover, withdraw everything above `base`; never inject. */
  | { readonly kind: "skim-to-base"; readonly base: number };

export interface WithdrawalEvent {
  /** Bar timestamp (epoch ms) at which the skim was applied. */
  readonly atUtc: number;
  /** Month that just ended, as YYYY-MM (UTC). */
  readonly monthKey: string;
  readonly equityBefore: number;
  readonly amountWithdrawn: number;
  readonly equityAfter: number;
}

/** Monotonic month bucket so consecutive months always compare as different. */
export function utcMonthIndex(epochMs: number): number {
  const d = new Date(epochMs);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

export function utcMonthKey(epochMs: number): string {
  const d = new Date(epochMs);
  const m = d.getUTCMonth() + 1;
  return `${d.getUTCFullYear()}-${m < 10 ? `0${m}` : m}`;
}

/**
 * Pure skim: returns the post-withdrawal equity and the amount removed.
 * Withdraws realized equity above `base`; if equity ≤ base, nothing moves
 * (a losing month is carried, never topped up).
 */
export function applySkim(
  equity: number,
  policy: WithdrawalPolicy,
): { readonly equity: number; readonly withdrawn: number } {
  if (policy.kind === "none") return { equity, withdrawn: 0 };
  if (equity <= policy.base) return { equity, withdrawn: 0 };
  return { equity: policy.base, withdrawn: equity - policy.base };
}
