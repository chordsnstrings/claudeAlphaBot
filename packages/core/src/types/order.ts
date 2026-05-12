/** Spec §5.1 — Order request/result/update types passed through ExecutionAdapter. */

import type { Direction } from "./bar.js";
import type { Signal } from "./signal.js";

export type OrderType = "market" | "limit" | "stop";

export type OrderSide = Direction;

/** What the engine asks the ExecutionAdapter to do. */
export interface OrderRequest {
  /** Client-side correlation ID (UUID). */
  clientOrderId: string;
  /** Originating signal (so the audit trail can link order -> signal). */
  signal: Signal;
  instrument: string;
  direction: OrderSide;
  orderType: OrderType;
  lotSize: number;
  /** For market orders the adapter may ignore `price`. */
  price: number | null;
  stopPrice: number;
  targetPrice: number;
  /** Strategy that owns this order; copied from the signal for convenience. */
  originatingStrategy: string;
  /** Free-form metadata (e.g. session_id, strategy parameters). */
  metadata: Record<string, unknown>;
}

export type OrderStatus =
  | "submitted"
  | "accepted"
  | "filled"
  | "partially_filled"
  | "rejected"
  | "cancelled"
  | "expired";

export interface OrderResult {
  /** Broker-side order ID (or simulated UUID in backtest). */
  orderId: string;
  /** Echo of the client correlation ID. */
  clientOrderId: string;
  status: OrderStatus;
  /** Average fill price if filled / partially_filled. */
  fillPrice: number | null;
  fillTime: Date | null;
  filledLots: number;
  /** Populated when status='rejected'. */
  rejectionReason: string | null;
  /** Broker-side position ID, if the fill created or modified one. */
  brokerPositionId: string | null;
}

export interface OrderUpdate {
  orderId: string;
  status: OrderStatus;
  fillPrice: number | null;
  fillTime: Date | null;
  filledLots: number;
  rejectionReason: string | null;
  brokerPositionId: string | null;
}
