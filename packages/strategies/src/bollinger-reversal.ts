/**
 * Bollinger Reversal — spec §10.4 (multi-day mean reversion).
 *
 * Wait for daily close OUTSIDE the 2-stddev band. Track the extreme high
 * (above) or low (below) during the "outside" period. On the bar where
 * close returns INSIDE the band, enter a counter-trend position with
 * stop beyond the extreme and target at SMA20 (mean) or 2R.
 *
 * Per-instrument state machine: idle / above / below.
 */

import { randomUUID } from "node:crypto";

import {
  type Bar,
  type MarketState,
  type Position,
  type PositionEvent,
  type Signal,
  type Strategy,
  type StrategyConfig,
  type StrategyContext,
} from "@trading/core";

export interface BollingerReversalParams {
  bbPeriod: number;
  bbStdDev: number;
  maxHoldDays: number;
  stopBufferPips: number;
  targetType: "sma" | "2r";
}

export const BOLLINGER_REVERSAL_DEFAULTS: BollingerReversalParams = {
  bbPeriod: 20,
  bbStdDev: 2,
  maxHoldDays: 10,
  stopBufferPips: 1.5,
  targetType: "sma",
};

type OutsideState = "idle" | "above" | "below";

function pipSizeFor(instrument: string): number {
  if (instrument.endsWith("JPY")) {return 0.01;}
  if (
    instrument === "XAUUSD" ||
    instrument === "XAGUSD" ||
    instrument === "BRENTCMDUSD" ||
    instrument === "LIGHTCMDUSD"
  ) {
    return 0.01;
  }
  return 0.0001;
}

export class BollingerReversalStrategy implements Strategy {
  public readonly name = "bollinger-reversal";
  public readonly config: StrategyConfig;
  private readonly params: BollingerReversalParams;
  private outsideState: OutsideState = "idle";
  private extremeOutside: number | null = null;
  private readonly openByInstrument = new Map<string, Position>();

  constructor(
    public readonly instrument: string,
    overrides: Partial<BollingerReversalParams> = {},
  ) {
    this.params = { ...BOLLINGER_REVERSAL_DEFAULTS, ...overrides };
    this.config = {
      name: this.name,
      parameters: this.params as unknown as Record<string, unknown>,
      instruments: [instrument],
      timeframes: ["d1"],
      allocationFraction: 1,
      enabled: true,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async initialize(_ctx: StrategyContext): Promise<void> {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async generateSignals(state: MarketState): Promise<Signal[]> {
    if (state.currentBar.timeframe !== "d1") {
      return [];
    }
    if (this.openByInstrument.has(state.instrument)) {
      return [];
    }
    const bb = state.indicators.bb20;
    if (bb === null) {
      return [];
    }
    const bar = state.currentBar;

    if (this.outsideState === "idle") {
      if (bar.close > bb.upper) {
        this.outsideState = "above";
        this.extremeOutside = bar.high;
      } else if (bar.close < bb.lower) {
        this.outsideState = "below";
        this.extremeOutside = bar.low;
      }
      return [];
    }
    if (this.outsideState === "above") {
      if (bar.high > (this.extremeOutside ?? -Infinity)) {
        this.extremeOutside = bar.high;
      }
      if (bar.close < bb.upper) {
        // Re-entry → short
        const extreme = this.extremeOutside ?? bar.high;
        const stop =
          extreme + this.params.stopBufferPips * pipSizeFor(this.instrument);
        const target = this.computeTarget(bar, bb.middle, stop, "short");
        this.outsideState = "idle";
        this.extremeOutside = null;
        return [this.signal(bar, "short", bar.close, stop, target)];
      }
      return [];
    }
    if (this.outsideState === "below") {
      if (bar.low < (this.extremeOutside ?? Infinity)) {
        this.extremeOutside = bar.low;
      }
      if (bar.close > bb.lower) {
        const extreme = this.extremeOutside ?? bar.low;
        const stop =
          extreme - this.params.stopBufferPips * pipSizeFor(this.instrument);
        const target = this.computeTarget(bar, bb.middle, stop, "long");
        this.outsideState = "idle";
        this.extremeOutside = null;
        return [this.signal(bar, "long", bar.close, stop, target)];
      }
      return [];
    }
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async updateState(_state: MarketState): Promise<void> {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async onPositionEvent(ev: PositionEvent): Promise<void> {
    if (ev.position.originatingStrategy !== this.name) {
      return;
    }
    if (ev.type === "opened" || ev.type === "modified") {
      this.openByInstrument.set(ev.position.instrument, ev.position);
    } else {
      this.openByInstrument.delete(ev.position.instrument);
    }
  }

  getOpenPositions(): Position[] {
    return [...this.openByInstrument.values()];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async shutdown(): Promise<void> {}

  private computeTarget(
    bar: Bar,
    smaMiddle: number,
    stop: number,
    direction: "long" | "short",
  ): number {
    if (this.params.targetType === "sma") {
      return smaMiddle;
    }
    return direction === "long"
      ? bar.close + 2 * (bar.close - stop)
      : bar.close - 2 * (stop - bar.close);
  }

  private signal(
    bar: Bar,
    direction: "long" | "short",
    entry: number,
    stop: number,
    target: number,
  ): Signal {
    return {
      id: randomUUID(),
      originatingStrategy: this.name,
      instrument: bar.instrument,
      direction,
      proposedEntryPrice: entry,
      proposedStopPrice: stop,
      proposedTargetPrice: target,
      proposedSizeFractionOfAllocation: 1,
      urgencyScore: 0.5,
      signalType: `bb_reentry_${direction}`,
      entryReason: `Bollinger band re-entry from ${this.outsideState}`,
      generatedAtBar: bar.timestampUtc,
      metadata: { params: this.params },
    };
  }
}
