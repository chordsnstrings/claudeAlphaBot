/**
 * RiskManager — gate every OrderRequest against account-level limits before
 * the ExecutionAdapter sees it. Concrete impl in Phase 10.
 *
 * Spec §9.5 / §9.10.
 */

import type { AccountInfo } from "../types/account.js";
import type { OrderRequest } from "../types/order.js";

export interface RiskCheckResult {
  /** True = the order is permitted. */
  allowed: boolean;
  /** Human-readable reason when allowed=false; for audit logs. */
  reason: string | null;
  /** Optional adjusted lot size (e.g. after risk-fraction capping). */
  adjustedLotSize: number | null;
}

export interface RiskManager {
  canExecute(order: OrderRequest, account: AccountInfo): RiskCheckResult;
  /** Account-wide halt check; the engine consults this each bar. */
  shouldHalt(account: AccountInfo): { halt: boolean; reason: string | null };
}
