/**
 * Cross-sectional (relative-strength) momentum — the market-NEUTRAL complement
 * to time-series momentum.
 *
 * Each bar, rank the universe by trailing return and hold the strongest N
 * **long** and the weakest N **short**, equal notional. Because the book is
 * (roughly) dollar-neutral, it strips out crypto's dominant market beta and
 * profits from *dispersion between assets* — winners continuing to outrun
 * losers — regardless of whether the whole market is up or down. That is a
 * fundamentally different (lower-beta) return profile than TS-momentum, which
 * is the point: a market-direction-agnostic sleeve the orchestrator can lean on
 * when directional trends aren't paying.
 *
 * Architecture: the per-instrument engine creates one strategy instance per
 * instrument, so the cross-asset ranking lives in a shared {@link
 * CrossSectionalBook} that every instance writes its latest close into and
 * reads the current target long/short set from. Ranking uses only trailing
 * closes (no lookahead). Daily, close-only friendly.
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

export interface CrossSectionalMomentumParams {
  /** Trailing-return lookback in bars used for ranking. */
  lookbackBars: number;
  /** Number of top-ranked assets to hold long. */
  nLong: number;
  /** Number of bottom-ranked assets to hold short. */
  nShort: number;
  /** Require a positive score to go long / negative to go short (skip flat-ish names). */
  signFilter: number;
  /** Disaster-stop distance in ATR multiples (wide; rank-exit is the real exit). */
  atrStopMultiplier: number;
}

export const CROSS_SECTIONAL_MOMENTUM_DEFAULTS: CrossSectionalMomentumParams = {
  lookbackBars: 90,
  nLong: 2,
  nShort: 2,
  signFilter: 1,
  atrStopMultiplier: 20,
};

/** Shared cross-asset ranking state for one cross-sectional book. */
export class CrossSectionalBook {
  private readonly series = new Map<string, number[]>();

  constructor(private readonly params: CrossSectionalMomentumParams) {}

  /** Append the latest close for an instrument (trailing buffer, capped). */
  record(instrument: string, close: number): void {
    const arr = this.series.get(instrument) ?? [];
    arr.push(close);
    if (arr.length > this.params.lookbackBars + 5) {
      arr.shift();
    }
    this.series.set(instrument, arr);
  }

  private score(instrument: string): number | null {
    const arr = this.series.get(instrument);
    if (arr === undefined || arr.length <= this.params.lookbackBars) {
      return null;
    }
    const cur = arr[arr.length - 1];
    const past = arr[arr.length - 1 - this.params.lookbackBars];
    if (cur === undefined || past === undefined || past <= 0) {
      return null;
    }
    return (cur - past) / past;
  }

  /** Current target direction for an instrument: long / short / flat. */
  target(instrument: string): "long" | "short" | null {
    const scored: Array<{ inst: string; score: number }> = [];
    for (const inst of this.series.keys()) {
      const s = this.score(inst);
      if (s !== null) {
        scored.push({ inst, score: s });
      }
    }
    if (scored.length < this.params.nLong + this.params.nShort) {
      return null; // not enough warm names to form a balanced book
    }
    scored.sort((a, b) => b.score - a.score);
    const longs = scored.slice(0, this.params.nLong);
    const shorts = scored.slice(scored.length - this.params.nShort);
    if (longs.some((x) => x.inst === instrument)) {
      const self = longs.find((x) => x.inst === instrument);
      if (this.params.signFilter >= 1 && self !== undefined && self.score <= 0) {
        return null;
      }
      return "long";
    }
    if (shorts.some((x) => x.inst === instrument)) {
      const self = shorts.find((x) => x.inst === instrument);
      if (this.params.signFilter >= 1 && self !== undefined && self.score >= 0) {
        return null;
      }
      return "short";
    }
    return null;
  }
}

export class CrossSectionalMomentumStrategy implements Strategy {
  public readonly name = "xsmom";
  public readonly config: StrategyConfig;
  private readonly params: CrossSectionalMomentumParams;
  private readonly openByInstrument = new Map<string, Position>();

  constructor(
    public readonly instrument: string,
    private readonly book: CrossSectionalBook,
    overrides: Partial<CrossSectionalMomentumParams> = {},
  ) {
    this.params = { ...CROSS_SECTIONAL_MOMENTUM_DEFAULTS, ...overrides };
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
    // Always feed the shared book first so the ranking is current.
    this.book.record(state.instrument, state.currentBar.close);
    if (this.openByInstrument.has(state.instrument)) {
      return [];
    }
    const atr14 = state.indicators.atr14;
    if (atr14 === null || atr14 <= 0) {
      return [];
    }
    const dir = this.book.target(state.instrument);
    if (dir === null) {
      return [];
    }
    const bar = state.currentBar;
    const stopDist = this.params.atrStopMultiplier * atr14;
    const stop = dir === "long" ? bar.close - stopDist : bar.close + stopDist;
    const target = dir === "long" ? bar.close + 100 * stopDist : bar.close - 100 * stopDist;
    return [this.signal(bar, dir, bar.close, stop, target)];
  }

  /** Exit when this instrument leaves its target long/short slot. */
  exitsForBar(state: MarketState): ExitRequest[] {
    const pos = this.openByInstrument.get(state.instrument);
    if (pos === undefined) {
      return [];
    }
    const dir = this.book.target(state.instrument);
    if (dir === pos.direction) {
      return [];
    }
    return [{ positionId: pos.id, reason: "signal_flip" }];
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
      signalType: `xsmom_${direction}`,
      entryReason: `cross-sectional ${this.params.lookbackBars}-bar rank`,
      generatedAtBar: bar.timestampUtc,
      metadata: { params: this.params },
    };
  }
}
