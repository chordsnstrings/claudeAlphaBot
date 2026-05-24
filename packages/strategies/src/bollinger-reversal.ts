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
  /**
   * Wide disaster-stop in ATR multiples (0 = legacy "extreme + stopBufferPips"
   * tight stop). On close-only data a TIGHT stop is untrustworthy — an intrabar
   * wick through it is invisible, so the position survives to a better close
   * and the win-rate is inflated (the FX mean-reversion artifact). A WIDE ATR
   * stop, with the mean (SMA) as the real target, is honestly backtestable:
   * both entry and exit happen at observed closes.
   */
  atrStopMultiplier: number;
  /**
   * Ranging-regime filter (0 = off): only enter when ADX(14) < adxMax. Mean
   * reversion is the right strategy precisely when there is NO trend; in a
   * trend it gets run over. This is the half of the orchestrator that
   * complements momentum's ADX>=adxMin trend filter.
   */
  adxMax: number;
}

export const BOLLINGER_REVERSAL_DEFAULTS: BollingerReversalParams = {
  bbPeriod: 20,
  bbStdDev: 2,
  maxHoldDays: 10,
  stopBufferPips: 1.5,
  targetType: "sma",
  atrStopMultiplier: 0,
  adxMax: 0,
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
        this.outsideState = "idle";
        this.extremeOutside = null;
        if (this.tooTrending(state)) {
          return [];
        }
        const stop = this.stopFor(bar, "short", extreme, state.indicators.atr14);
        const target = this.computeTarget(bar, bb.middle, stop, "short");
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
        this.outsideState = "idle";
        this.extremeOutside = null;
        if (this.tooTrending(state)) {
          return [];
        }
        const stop = this.stopFor(bar, "long", extreme, state.indicators.atr14);
        const target = this.computeTarget(bar, bb.middle, stop, "long");
        return [this.signal(bar, "long", bar.close, stop, target)];
      }
      return [];
    }
    return [];
  }

  /** Ranging-regime filter: skip entries when ADX says we're trending. */
  private tooTrending(state: MarketState): boolean {
    if (this.params.adxMax <= 0) {
      return false;
    }
    const adx = state.indicators.adx14;
    return adx === null || adx.adx >= this.params.adxMax;
  }

  /** Wide ATR disaster stop (honest on close-only) or the legacy tight stop. */
  private stopFor(
    bar: Bar,
    direction: "long" | "short",
    extreme: number,
    atr14: number | null,
  ): number {
    if (this.params.atrStopMultiplier > 0 && atr14 !== null && atr14 > 0) {
      const dist = this.params.atrStopMultiplier * atr14;
      return direction === "long" ? bar.close - dist : bar.close + dist;
    }
    const buf = this.params.stopBufferPips * pipSizeFor(this.instrument);
    return direction === "long" ? extreme - buf : extreme + buf;
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
