/**
 * Orchestrator — aggregates per-strategy signals into a single ordered
 * stream of OrderRequests for the engine to submit. The concrete impl
 * lands in Phase 14; this interface fixes the shape now so dependent
 * code can target it.
 *
 * Spec §9.5 T5.6 / §9.14.
 */

import type { OrderRequest } from "../types/order.js";
import type { Signal } from "../types/signal.js";

export interface OrchestratorContext {
  /** Equity in USD at the current bar. */
  accountEquityUsd: number;
  /** Sum of open risk across all strategies, as % of equity. */
  totalOpenRiskPct: number;
}

export interface Orchestrator {
  /**
   * Take the per-strategy signals produced this bar plus the current
   * account state, and return the OrderRequests the engine should try to
   * submit (in priority order).
   */
  process(signals: Signal[], context: OrchestratorContext): OrderRequest[];

  /**
   * Optional per-bar observation hook. The engine calls this once per
   * processed bar with the current mark-to-market equity, BEFORE signal
   * processing — even on bars with no signals. Stateful orchestrators use it
   * to maintain an equity curve for volatility targeting and drawdown-based
   * de-risking. `process` is only called on signal bars, so it can't carry a
   * continuous equity series. Stateless orchestrators omit this.
   */
  onBar?(equityUsd: number, now: Date): void;
}
