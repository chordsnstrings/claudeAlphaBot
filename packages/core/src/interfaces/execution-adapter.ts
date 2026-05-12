/** Spec §9.5 T5.2 — ExecutionAdapter boundary. */

import type { AccountInfo } from "../types/account.js";
import type {
  OrderRequest,
  OrderResult,
  OrderUpdate,
} from "../types/order.js";
import type { Position } from "../types/position.js";

/** Patch applied to an existing order (price, stop, target, lot size). */
export interface OrderModification {
  price?: number;
  stopPrice?: number;
  targetPrice?: number;
  lotSize?: number;
}

export interface ExecutionAdapter {
  submitOrder(order: OrderRequest): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;
  modifyOrder(
    orderId: string,
    updates: OrderModification,
  ): Promise<OrderResult>;
  closePosition(positionId: string): Promise<OrderResult>;
  getOpenPositions(): Promise<Position[]>;
  getAccountInfo(): Promise<AccountInfo>;
  /** Live broker updates pushed to the engine; backtest emits synthetic fills. */
  subscribeOrderUpdates(): AsyncIterable<OrderUpdate>;
  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;
}
