/**
 * Time-Series Trend Following — spec §10.3.
 *
 * Hold position in the direction of the 12-month price trend, confirmed
 * by SMA50 vs SMA200. Entry: trendBullish AND flat -> long; trendBearish
 * AND flat -> short. Initial stop at 3 × ATR(14). Trailing stop / signal
 * flip exits are deferred (engine handles stop/target).
 */

import { randomUUID } from "node:crypto";

import {
  type MarketState,
  type Position,
  type PositionEvent,
  type Signal,
  type Strategy,
  type StrategyConfig,
  type StrategyContext,
} from "@trading/core";

export interface TrendFollowingParams {
  momentumLookbackBars: number;
  fastSmaPeriod: number;
  slowSmaPeriod: number;
  atrStopMultiplier: number;
}

export const TREND_FOLLOWING_DEFAULTS: TrendFollowingParams = {
  momentumLookbackBars: 252,
  fastSmaPeriod: 50,
  slowSmaPeriod: 200,
  atrStopMultiplier: 3.0,
};

export class TrendFollowingStrategy implements Strategy {
  public readonly name = "trend-following";
  public readonly config: StrategyConfig;
  private readonly params: TrendFollowingParams;
  private readonly openByInstrument = new Map<string, Position>();

  constructor(
    public readonly instrument: string,
    overrides: Partial<TrendFollowingParams> = {},
  ) {
    this.params = { ...TREND_FOLLOWING_DEFAULTS, ...overrides };
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
    const { atr14, sma50, sma200, pastReturn252 } = state.indicators;
    if (atr14 === null || sma50 === null || sma200 === null || pastReturn252 === null) {
      return [];
    }
    const bar = state.currentBar;
    const bullish = pastReturn252 > 0 && sma50 > sma200;
    const bearish = pastReturn252 < 0 && sma50 < sma200;
    if (bullish) {
      const stop = bar.close - this.params.atrStopMultiplier * atr14;
      return [this.signal(bar, "long", bar.close, stop, bar.close + 5 * atr14)];
    }
    if (bearish) {
      const stop = bar.close + this.params.atrStopMultiplier * atr14;
      return [this.signal(bar, "short", bar.close, stop, bar.close - 5 * atr14)];
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

  private signal(
    bar: MarketState["currentBar"],
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
      signalType: `trend_${direction}`,
      entryReason: `Trend-following entry: pastReturn252 + SMA50/SMA200 confirm`,
      generatedAtBar: bar.timestampUtc,
      metadata: { params: this.params },
    };
  }
}
