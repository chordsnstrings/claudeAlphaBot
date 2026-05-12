/**
 * SimulatedClock — backtest-mode {@link Clock}.
 *
 * Spec §9.8. The engine calls `advanceTo(bar.timestampUtc)` at the start
 * of each bar; `now()` returns the most recent timestamp the clock has
 * been advanced to. `sleep()` is a no-op (backtests don't wait on wall
 * time).
 */

import type { Clock } from "@trading/core";

export class SimulatedClock implements Clock {
  private current: Date;

  constructor(start: Date) {
    this.current = start;
  }

  now(): Date {
    return this.current;
  }

  /** Move the clock forward (only). Going backwards is rejected. */
  advanceTo(t: Date): void {
    if (t.getTime() < this.current.getTime()) {
      // Bars can arrive across instruments where one pair lags slightly;
      // accept equal-or-greater and silently ignore older.
      return;
    }
    this.current = t;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async sleep(_ms: number): Promise<void> {
    // No-op in backtest. The engine drives the time cursor explicitly via
    // advanceTo(); blocking on wall time would only slow tests down.
  }
}
