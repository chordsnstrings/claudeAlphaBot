/**
 * MetricsCollector — accumulates per-bar performance numbers (equity,
 * drawdown, P&L). Concrete impl in Phase 9.
 *
 * Spec §9.5 / §9.9.
 */

import type { MarketState } from "../types/market-state.js";
import type { Position } from "../types/position.js";

export interface ClosedTradeRecord {
  position: Position;
  exitPrice: number;
  exitTime: Date;
  realizedPnLUsd: number;
  realizedPnLPct: number;
  realizedRMultiple: number;
}

export interface MetricsCollector {
  /** Called once per bar after orders + position events have been processed. */
  update(state: MarketState, closedThisBar: ClosedTradeRecord[]): void;

  /** Snapshot of accumulated metrics for reporting. */
  snapshot(): Record<string, unknown>;
}
