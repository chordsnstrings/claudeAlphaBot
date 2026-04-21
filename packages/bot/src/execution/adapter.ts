/**
 * ExecutionAdapter — spec §10.21. A single interface used by all three
 * trading modes (backtest, paper, live). Core decision logic calls this
 * abstraction; each mode provides its own implementation.
 *
 * The adapter is responsible ONLY for execution-layer concerns:
 *   - entering positions (submitEntry)
 *   - deciding when a position has hit its stop / TP / time stop
 *     against the latest candle (checkExits)
 *   - forcing a position closed (closePosition — emergency / manual)
 *   - startup reconciliation with any external state (reconcile)
 *
 * Everything above this layer (strategy evaluation, risk sizing, veto
 * composition, circuit breakers) is identical across modes per the hard
 * architectural requirement in spec §1.2 ("All three modes use identical
 * decision logic").
 */
import type {
  BotMode,
  Candle,
  ExitReason,
  OpenPosition,
  SizedSignal,
  Trade,
} from "@hydra/shared";

/** Opaque external handle returned by `submitEntry()`. */
export interface EntryResult {
  readonly position: OpenPosition;
  /** Fee paid for the entry fill (in USD). */
  readonly feePaid: number;
}

/**
 * A fill event emitted during `checkExits` for a single position. Multiple
 * fills can be emitted per candle (e.g. TP1 partial, then TP2 full).
 */
export interface ExitEvent {
  readonly exitReason: ExitReason;
  readonly exitPrice: number;
  readonly closeQuantity: number;
  readonly feePaid: number;
  readonly fullyClosed: boolean;
  /** Final trade row to persist (only emitted on full close). */
  readonly trade?: Trade;
  /** Updated position for partial fills (TP1). Undefined on full close. */
  readonly updatedPosition?: OpenPosition;
}

export interface CheckExitsInputs {
  readonly position: OpenPosition;
  readonly candle: Candle;
  readonly accountEquityBefore: number;
  readonly nowUtc: number;
}

export interface ExecutionAdapter {
  readonly mode: BotMode;

  /** Submit a sized entry. Resolves once the entry fill is confirmed. */
  submitEntry(signal: SizedSignal, nowUtc: number): Promise<EntryResult>;

  /**
   * Evaluate exits for one position against the given (closed) candle.
   * Returns 0, 1, or 2 fills (TP1 partial + nothing else in the same call;
   * a subsequent candle will trigger TP2 or stop).
   */
  checkExits(inputs: CheckExitsInputs): Promise<readonly ExitEvent[]>;

  /**
   * Force-close a position immediately at market. Used for manual
   * operator override, circuit breakers, and shutdown.
   */
  closePosition(
    position: OpenPosition,
    reason: ExitReason,
    nowUtc: number,
    accountEquityBefore: number,
  ): Promise<ExitEvent>;

  /**
   * Startup reconciliation — rebuild local state from any external
   * authority (the exchange in live mode; nothing in backtest/paper).
   * Returns positions that still exist upstream.
   */
  reconcile(): Promise<readonly OpenPosition[]>;

  /** Shutdown: cancel any open timers / sockets. */
  close(): Promise<void>;
}
