/**
 * Donchian Breakout — spec §10.2 (Turtle System 1 style).
 *
 * Long on daily close > rolling 20-day high (excluding current bar).
 * Short on daily close < rolling 20-day low. Initial stop at 2 × ATR(14)
 * from entry. The spec also calls for an ATR-percentile filter (skip
 * when below 20 or above 95) and a trailing-stop / Donchian-exit
 * mechanism — Phase 13 ships the entry logic; trailing stops + signal-
 * flip exits land when the engine supports strategy-driven position
 * modification (deferred).
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

export interface DonchianBreakoutParams {
  entryLookback: number;
  /** Skip when ATR percentile falls outside [atrMin, atrMax]. */
  atrPctMin: number;
  atrPctMax: number;
  atrStopMultiplier: number;
}

export const DONCHIAN_DEFAULTS: DonchianBreakoutParams = {
  entryLookback: 20,
  atrPctMin: 0.2,
  atrPctMax: 0.95,
  atrStopMultiplier: 2.0,
};

export class DonchianBreakoutStrategy implements Strategy {
  public readonly name = "donchian-breakout";
  public readonly config: StrategyConfig;
  private readonly params: DonchianBreakoutParams;
  private readonly openByInstrument = new Map<string, Position>();

  constructor(
    public readonly instrument: string,
    overrides: Partial<DonchianBreakoutParams> = {},
  ) {
    this.params = { ...DONCHIAN_DEFAULTS, ...overrides };
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
    if (state.currentBar.instrument !== this.instrument) {
      return [];
    }
    if (this.openByInstrument.has(state.instrument)) {
      return [];
    }
    const ind = state.indicators;
    const high20 = ind.rollingHigh20;
    const low20 = ind.rollingLow20;
    const atr14 = ind.atr14;
    const atrPct = ind.atrPercentile60;
    if (high20 === null || low20 === null || atr14 === null || atrPct === null) {
      return [];
    }
    // Skip chop / panic regimes.
    if (atrPct < this.params.atrPctMin || atrPct > this.params.atrPctMax) {
      return [];
    }
    const bar = state.currentBar;
    if (bar.close > high20) {
      const stop = bar.close - this.params.atrStopMultiplier * atr14;
      return [this.signal(bar, "long", bar.close, stop, bar.close + 2 * atr14)];
    }
    if (bar.close < low20) {
      const stop = bar.close + this.params.atrStopMultiplier * atr14;
      return [this.signal(bar, "short", bar.close, stop, bar.close - 2 * atr14)];
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
      urgencyScore: 0.6,
      signalType: `donchian_${direction}`,
      entryReason: `Donchian ${this.params.entryLookback}-day breakout`,
      generatedAtBar: bar.timestampUtc,
      metadata: { params: this.params },
    };
  }
}
