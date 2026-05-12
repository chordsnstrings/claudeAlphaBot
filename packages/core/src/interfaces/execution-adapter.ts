/** Spec §9.5 T5.2 — ExecutionAdapter boundary. */

import type { AccountInfo } from "../types/account.js";
import type { Bar } from "../types/bar.js";
import type {
  OrderRequest,
  OrderResult,
  OrderUpdate,
} from "../types/order.js";
import type { ExitReason, Position } from "../types/position.js";

/** Patch applied to an existing order (price, stop, target, lot size). */
export interface OrderModification {
  price?: number;
  stopPrice?: number;
  targetPrice?: number;
  lotSize?: number;
}

/** Context the engine can pass to `closePosition` so backtest adapters
 * can attribute exit reason + intended price without inferring them. */
export interface CloseContext {
  atPrice?: number;
  reason?: ExitReason;
}

/** Per-bar context for the backtest `processBar` hook. */
export interface ProcessBarContext {
  /** ATR(14) at this bar; null while warming up. */
  atr14: number | null;
  /** Median ATR(14) over the trailing 60 bars; null while warming up. */
  medianAtr14_60d: number | null;
}

export interface ExecutionAdapter {
  submitOrder(order: OrderRequest): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;
  modifyOrder(
    orderId: string,
    updates: OrderModification,
  ): Promise<OrderResult>;
  closePosition(positionId: string, ctx?: CloseContext): Promise<OrderResult>;
  getOpenPositions(): Promise<Position[]>;
  getAccountInfo(): Promise<AccountInfo>;
  /** Live broker updates pushed to the engine; backtest emits synthetic fills. */
  subscribeOrderUpdates(): AsyncIterable<OrderUpdate>;
  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;

  /**
   * Optional bar-tick hook used by backtest adapters to advance the
   * simulated clock, detect stop/target hits, and emit synthetic order
   * updates. Returns the events generated this bar (so the engine can
   * dispatch them inline before signal generation). Live adapters omit
   * this method.
   */
  processBar?(bar: Bar, ctx?: ProcessBarContext): Promise<OrderUpdate[]>;
}
