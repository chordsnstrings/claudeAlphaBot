/**
 * Cross-package type definitions. Spec: trading_system_docs.md sections
 * 5.1 (core types) and 14 (asset universe).
 *
 * Interfaces for the boundary adapters (MarketDataFeed, ExecutionAdapter,
 * Clock, Strategy) land here in Phase 5. Phase 1 only declares the small
 * set of names that the data + config modules already need.
 */

export type Timeframe = "m1" | "m5" | "h1" | "d1";
export type Direction = "long" | "short";
export type Mode = "backtest" | "live";

/** Spec 5.1 Bar. Prices and volume are plain numbers in code; the DB
 *  stores them as `numeric(18,6)` / `numeric(18,2)`. */
export interface Bar {
  instrument: string;
  timeframe: Timeframe;
  timestampUtc: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: "historical" | "live";
}

/** Convenience for narrowing operations against the asset universe. */
export type InstrumentId = string;
