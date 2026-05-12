/** Spec §5.1 — Position, ExitReason, PositionEvent. */

import type { Direction } from "./bar.js";

export type ExitReason =
  | "target"
  | "stop"
  | "be_stop"
  | "time_stop"
  | "session_close"
  | "signal_flip"
  | "orchestrator_close"
  | "manual_close"
  | "emergency_stop"
  | "data_end";

export interface FrictionUsd {
  spread: number;
  slippage: number;
  commission: number;
  swap: number;
}

export interface Position {
  id: string;
  sessionId: string;
  originatingSignalId: string;
  originatingStrategy: string;
  instrument: string;
  direction: Direction;
  entryPrice: number;
  entryTime: Date;
  currentStopPrice: number;
  currentTargetPrice: number;
  lotSize: number;
  notionalUsd: number;
  /** Initial risk as percent of account equity at entry. */
  initialRiskPct: number;
  initialRiskUsd: number;
  frictionPaidUsd: FrictionUsd;
  unrealizedPnLUsd: number;
  unrealizedPnLPct: number;
  /** Broker IDs are present in live mode only. */
  brokerOrderId: string | null;
  brokerPositionId: string | null;
}

/** Strategy notification when a position opens, modifies, or closes. */
export type PositionEvent =
  | { type: "opened"; position: Position }
  | { type: "modified"; position: Position }
  | {
      type: "closed";
      position: Position;
      exitReason: ExitReason;
      exitPrice: number;
      exitTime: Date;
      realizedPnLUsd: number;
      realizedPnLPct: number;
      realizedRMultiple: number;
    };
