/** Spec §5.1 — Bar, Timeframe, Direction, basic enums. */

export type Timeframe = "m1" | "m5" | "h1" | "d1";
export type Direction = "long" | "short";
export type Mode = "backtest" | "live";

/**
 * One OHLCV bar. Prices and volume are plain JS numbers; the DB stores
 * them as `numeric(18,6)` / `numeric(18,2)` (see schema/bar.ts). Constraint
 * `high >= max(open, close, low)` and `low <= min(open, close, high)` is
 * enforced both in the DB (CHECK) and at the data-validation layer.
 */
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

export type InstrumentId = string;
