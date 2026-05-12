/** Spec §9.5 T5.1 — MarketDataFeed boundary. */

import type { Bar, Timeframe } from "../types/bar.js";

export interface MarketDataFeed {
  /**
   * Stream of bars for one (instrument, timeframe). Implementations decide
   * the iteration semantics: HistoricalDataFeed completes when the cursor
   * reaches the end of the time range; LiveDataFeed runs forever until
   * `stop()` is called.
   */
  subscribe(instrument: string, timeframe: Timeframe): AsyncIterable<Bar>;

  /**
   * Bulk fetch of historical bars; used by the engine for indicator
   * warm-up on session start.
   */
  getHistoricalBars(
    instrument: string,
    timeframe: Timeframe,
    from: Date,
    to: Date,
  ): Promise<Bar[]>;

  /** Most recent emitted bar, or null if no bar has been emitted yet. */
  getCurrentBar(instrument: string, timeframe: Timeframe): Bar | null;

  isConnected(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}
