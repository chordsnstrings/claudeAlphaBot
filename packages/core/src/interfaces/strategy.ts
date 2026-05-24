/** Spec §9.5 T5.4 — Strategy boundary. */

import type { MarketState } from "../types/market-state.js";
import type { ExitReason, Position, PositionEvent } from "../types/position.js";
import type { Signal } from "../types/signal.js";
import type {
  StrategyConfig,
  StrategyContext,
} from "../types/strategy-context.js";

/** A strategy-driven request to close one of its own open positions. */
export interface ExitRequest {
  positionId: string;
  reason: ExitReason;
}

export interface Strategy {
  readonly name: string;
  readonly config: StrategyConfig;

  /** One-time setup before the first bar. */
  initialize(context: StrategyContext): Promise<void>;

  /**
   * Emit zero or more proposed entries for the current bar. The engine
   * routes them through orchestrator + risk before any order is placed.
   */
  generateSignals(state: MarketState): Promise<Signal[]>;

  /**
   * Update any strategy-internal state after signals have been produced
   * AND any open positions have been processed. Stateful strategies use
   * this hook for trailing stops, regime updates, etc.
   */
  updateState(state: MarketState): Promise<void>;

  /**
   * Optional: positions the strategy wants to close on this bar for
   * reasons the engine's stop/target detection can't see — signal-flip,
   * time-stop, session-close, trailing-exit. The engine polls this each
   * bar (after exit detection, before signal generation) and routes each
   * request to execution.closePosition. Strategies without discretionary
   * exits omit this method.
   */
  exitsForBar?(state: MarketState): ExitRequest[];

  /** Fired when an owned position opens / modifies / closes. */
  onPositionEvent(event: PositionEvent): Promise<void>;

  /** Snapshot of positions this strategy currently owns. */
  getOpenPositions(): Position[];

  /** Final cleanup at session end. */
  shutdown(): Promise<void>;
}
