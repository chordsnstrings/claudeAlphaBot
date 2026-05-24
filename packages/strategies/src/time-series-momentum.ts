/**
 * Time-Series Momentum (TSMOM) — Moskowitz/Ooi/Pedersen (2012), one of the
 * most robustly replicated profitable anomalies across asset classes and
 * decades, FX included.
 *
 * Rule: hold a position in the direction of the trailing `lookbackBars`
 * return. Flip when that sign reverses. The exit is the SIGNAL FLIP (via
 * the engine's exitsForBar hook), NOT a tight price stop — that's the
 * crucial difference from the §10.3 trend-follower, whose tight ATR stop
 * gets whipsawed by daily noise on close-only data. A wide disaster stop
 * (atrStopMultiplier × ATR) only bounds catastrophic gaps.
 *
 * Daily timeframe, close-only friendly. One position per instrument.
 */

import { randomUUID } from "node:crypto";

import {
  type Bar,
  type ExitRequest,
  type MarketState,
  type Position,
  type PositionEvent,
  type Signal,
  type Strategy,
  type StrategyConfig,
  type StrategyContext,
} from "@trading/core";

export interface TimeSeriesMomentumParams {
  /** Long (primary) trailing-return lookback in bars (252 ≈ 12 months daily). */
  lookbackBars: number;
  /** Mid horizon as a fraction of lookbackBars (default 0.5 -> 126). */
  horizonMidFraction: number;
  /** Short horizon as a fraction of lookbackBars (default 0.25 -> 63). */
  horizonShortFraction: number;
  /**
   * 1 = only hold when ALL THREE horizons agree on sign (high-conviction,
   * flat in chop — the key consistency lever). 0 = majority sign.
   */
  requireAllAgree: number;
  /** Disaster-stop distance in ATR multiples (wide; the flip is the real exit). */
  atrStopMultiplier: number;
  /** Minimum |long-horizon return| to act on, filters weak trends. */
  minAbsReturn: number;
}

export const TSMOM_DEFAULTS: TimeSeriesMomentumParams = {
  lookbackBars: 252,
  horizonMidFraction: 0.5,
  horizonShortFraction: 0.25,
  requireAllAgree: 1,
  atrStopMultiplier: 20,
  minAbsReturn: 0,
};

function pastReturn(bars: readonly Bar[], lookback: number): number | null {
  if (bars.length <= lookback) {
    return null;
  }
  const cur = bars[bars.length - 1];
  const past = bars[bars.length - 1 - lookback];
  if (cur === undefined || past === undefined || past.close === 0) {
    return null;
  }
  return (cur.close - past.close) / past.close;
}

export class TimeSeriesMomentumStrategy implements Strategy {
  public readonly name = "tsmom";
  public readonly config: StrategyConfig;
  private readonly params: TimeSeriesMomentumParams;
  private readonly openByInstrument = new Map<string, Position>();

  constructor(
    public readonly instrument: string,
    overrides: Partial<TimeSeriesMomentumParams> = {},
  ) {
    this.params = { ...TSMOM_DEFAULTS, ...overrides };
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
      return []; // already positioned; exits handle flips
    }
    const atr14 = state.indicators.atr14;
    if (atr14 === null || atr14 <= 0) {
      return [];
    }
    const dir = this.momentumDirection(state.recentBars);
    if (dir === null) {
      return [];
    }
    const bar = state.currentBar;
    const stopDist = this.params.atrStopMultiplier * atr14;
    const stop = dir === "long" ? bar.close - stopDist : bar.close + stopDist;
    // Far target: the flip is the real exit, so set the target out of reach.
    const target = dir === "long" ? bar.close + 100 * stopDist : bar.close - 100 * stopDist;
    return [this.signal(bar, dir, bar.close, stop, target)];
  }

  /**
   * Exit when multi-horizon agreement no longer supports the held
   * direction — i.e. the blended signal flips OR drops to flat (chop). The
   * latter is what keeps the strategy out of the whipsaw regimes that drag
   * single-horizon momentum.
   */
  exitsForBar(state: MarketState): ExitRequest[] {
    const pos = this.openByInstrument.get(state.instrument);
    if (pos === undefined) {
      return [];
    }
    const dir = this.momentumDirection(state.recentBars);
    if (dir === pos.direction) {
      return [];
    }
    return [{ positionId: pos.id, reason: "signal_flip" }];
  }

  /**
   * Multi-horizon momentum direction. Returns 'long'/'short' when the
   * short/mid/long trailing-return signs satisfy the agreement rule, else
   * null (stay flat). minAbsReturn gates on the long-horizon magnitude.
   */
  private momentumDirection(bars: readonly Bar[]): "long" | "short" | null {
    const longH = this.params.lookbackBars;
    const midH = Math.max(1, Math.round(longH * this.params.horizonMidFraction));
    const shortH = Math.max(1, Math.round(longH * this.params.horizonShortFraction));
    const rLong = pastReturn(bars, longH);
    const rMid = pastReturn(bars, midH);
    const rShort = pastReturn(bars, shortH);
    if (rLong === null || rMid === null || rShort === null) {
      return null;
    }
    if (Math.abs(rLong) < this.params.minAbsReturn) {
      return null;
    }
    const signs: number[] = [rShort, rMid, rLong].map((r) => (r > 0 ? 1 : r < 0 ? -1 : 0));
    const sum = signs.reduce((a, b) => a + b, 0);
    if (this.params.requireAllAgree >= 1) {
      if (sum === 3) {
        return "long";
      }
      if (sum === -3) {
        return "short";
      }
      return null;
    }
    if (sum > 0) {
      return "long";
    }
    if (sum < 0) {
      return "short";
    }
    return null;
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
      signalType: `tsmom_${direction}`,
      entryReason: `TSMOM ${this.params.lookbackBars}-bar momentum`,
      generatedAtBar: bar.timestampUtc,
      metadata: { params: this.params },
    };
  }
}
