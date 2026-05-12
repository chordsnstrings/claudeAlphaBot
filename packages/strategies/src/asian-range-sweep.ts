/**
 * Asian Range Sweep — spec §10.1.
 *
 * Mean-reversion intraday: during 00:00-07:00 UTC ("Asian session") the
 * range forms with high (AH) and low (AL). At London open, price often
 * briefly breaches AH or AL then reverses; we enter on the reversal with
 * stops beyond the swept extreme.
 *
 * State is reset every UTC midnight. Per-day, at most one trade in each
 * direction (long sweep-of-low + short sweep-of-high).
 *
 * Daily ATR(14): the strategy needs daily ATR for sweep-depth scaling.
 * It preloads daily bars via the data feed in `initialize()` and computes
 * ATR(14) once for the whole range; lookups are by UTC date.
 */

import { randomUUID } from "node:crypto";

import {
  atr,
  logger,
  type Bar,
  type MarketState,
  type Position,
  type PositionEvent,
  type Signal,
  type Strategy,
  type StrategyConfig,
  type StrategyContext,
} from "@trading/core";

const log = logger("strategies.asian-range-sweep");

export interface AsianRangeSweepParams {
  minSweepAtr: number;
  maxSweepAtr: number;
  sweepMaxBars: number;
  displacementRatio: number;
  stopBufferPips: number;
  targetR: number;
  timeStopMinutes: number;
  breakevenAtR: number;
  asianStartUtcHour: number;
  asianEndUtcHour: number;
  londonOpenStartUtcHour: number;
  londonOpenStartUtcMinute: number;
  londonOpenEndUtcHour: number;
  londonOpenEndUtcMinute: number;
  sessionCloseUtcHour: number;
  /** Skip days with fewer than this many M1 bars in the Asian session. */
  minAsianBars: number;
}

export const DEFAULT_PARAMS: AsianRangeSweepParams = {
  minSweepAtr: 0.05,
  maxSweepAtr: 0.8,
  sweepMaxBars: 15,
  displacementRatio: 0.5,
  stopBufferPips: 1.5,
  targetR: 2.0,
  timeStopMinutes: 90,
  breakevenAtR: 1.0,
  asianStartUtcHour: 0,
  asianEndUtcHour: 7,
  londonOpenStartUtcHour: 7,
  londonOpenStartUtcMinute: 30,
  londonOpenEndUtcHour: 10,
  londonOpenEndUtcMinute: 30,
  sessionCloseUtcHour: 21,
  minAsianBars: 100,
};

type SweepState = "idle" | "breached" | "abandoned";

interface DayState {
  asianHigh: number;
  asianLow: number;
  asianBarCount: number;
  highSweepState: SweepState;
  lowSweepState: SweepState;
  highBreachExtreme: number;
  lowBreachExtreme: number;
  highBreachAtBar: number;
  lowBreachAtBar: number;
  tradeLongTaken: boolean;
  tradeShortTaken: boolean;
  /** Bar count since the day reset; for the sweepMaxBars timer. */
  barIndex: number;
}

function newDayState(): DayState {
  return {
    asianHigh: -Infinity,
    asianLow: Infinity,
    asianBarCount: 0,
    highSweepState: "idle",
    lowSweepState: "idle",
    highBreachExtreme: -Infinity,
    lowBreachExtreme: Infinity,
    highBreachAtBar: -1,
    lowBreachAtBar: -1,
    tradeLongTaken: false,
    tradeShortTaken: false,
    barIndex: 0,
  };
}

function pipSizeFor(instrument: string): number {
  if (instrument.endsWith("JPY")) {
    return 0.01;
  }
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

function utcDateKey(t: Date): string {
  return t.toISOString().slice(0, 10);
}

export class AsianRangeSweepStrategy implements Strategy {
  public readonly name = "asian-range-sweep";
  public readonly config: StrategyConfig;
  private readonly params: AsianRangeSweepParams;
  /** Daily ATR(14) keyed by UTC date. Preloaded in `initialize`. */
  private readonly dailyAtr = new Map<string, number>();
  private currentDay: string | null = null;
  private dayState: DayState | null = null;
  private readonly openByInstrument = new Map<string, Position>();
  /** Hold position IDs we've opened so the strategy can self-report. */
  private readonly mine = new Set<string>();

  constructor(
    public readonly instrument: string,
    overrides: Partial<AsianRangeSweepParams> = {},
    allocationFraction = 1,
  ) {
    this.params = { ...DEFAULT_PARAMS, ...overrides };
    this.config = {
      name: "asian-range-sweep",
      parameters: this.params as unknown as Record<string, unknown>,
      instruments: [instrument],
      timeframes: ["m1"],
      allocationFraction,
      enabled: true,
    };
  }

  async initialize(ctx: StrategyContext): Promise<void> {
    if (ctx.dataFeed === undefined) {
      throw new Error(
        "AsianRangeSweepStrategy requires StrategyContext.dataFeed (daily ATR preload)",
      );
    }
    // Pull a wide window of daily bars: the engine's MarketState gives
    // intraday context but daily ATR needs daily bars. Cover 2 years
    // before the start to ensure 14-bar warm-up.
    const now = ctx.clock?.now() ?? new Date();
    const from = new Date(now.getTime() - 2 * 365 * 86_400_000);
    const to = new Date(now.getTime() + 86_400_000);
    const dailyBars = await ctx.dataFeed.getHistoricalBars(
      this.instrument,
      "d1",
      from,
      to,
    );
    const atrSeries = atr(dailyBars, 14);
    for (let i = 0; i < dailyBars.length; i += 1) {
      const bar = dailyBars[i];
      const v = atrSeries[i];
      if (bar !== undefined && v !== null && v !== undefined) {
        this.dailyAtr.set(utcDateKey(bar.timestampUtc), v);
      }
    }
    log.info(
      {
        instrument: this.instrument,
        dailyBars: dailyBars.length,
        atrSamples: this.dailyAtr.size,
      },
      "asian-range-sweep initialized",
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async generateSignals(state: MarketState): Promise<Signal[]> {
    if (state.currentBar.timeframe !== "m1") {
      return [];
    }
    if (state.currentBar.instrument !== this.instrument) {
      return [];
    }
    const bar = state.currentBar;
    const dayKey = utcDateKey(bar.timestampUtc);

    // Day rollover — reset state at the first bar of a new UTC day.
    if (this.currentDay !== dayKey) {
      this.currentDay = dayKey;
      this.dayState = newDayState();
    }
    const day = this.dayState;
    if (day === null) {
      return [];
    }
    day.barIndex += 1;

    const hour = bar.timestampUtc.getUTCHours();
    const minute = bar.timestampUtc.getUTCMinutes();
    const minuteOfDay = hour * 60 + minute;
    const asianStart = this.params.asianStartUtcHour * 60;
    const asianEnd = this.params.asianEndUtcHour * 60;
    const lonStart =
      this.params.londonOpenStartUtcHour * 60 + this.params.londonOpenStartUtcMinute;
    const lonEnd =
      this.params.londonOpenEndUtcHour * 60 + this.params.londonOpenEndUtcMinute;

    // Asian session: accumulate range.
    if (minuteOfDay >= asianStart && minuteOfDay < asianEnd) {
      if (bar.high > day.asianHigh) {
        day.asianHigh = bar.high;
      }
      if (bar.low < day.asianLow) {
        day.asianLow = bar.low;
      }
      day.asianBarCount += 1;
      return [];
    }

    // London-open window: detect sweep + reversal.
    if (minuteOfDay < lonStart || minuteOfDay >= lonEnd) {
      return [];
    }

    // Per-day gates.
    if (day.asianBarCount < this.params.minAsianBars) {
      return [];
    }
    if (!Number.isFinite(day.asianHigh) || !Number.isFinite(day.asianLow)) {
      return [];
    }
    const atr14 = this.dailyAtr.get(dayKey);
    if (atr14 === undefined || atr14 <= 0) {
      return [];
    }

    const signals: Signal[] = [];
    // --- Long setup: sweep of low + reversal ----------------------------
    if (!day.tradeLongTaken) {
      const sig = this.tryLong(day, bar, atr14);
      if (sig !== null) {
        signals.push(sig);
        day.tradeLongTaken = true;
      }
    }
    // --- Short setup: sweep of high + reversal --------------------------
    if (!day.tradeShortTaken) {
      const sig = this.tryShort(day, bar, atr14);
      if (sig !== null) {
        signals.push(sig);
        day.tradeShortTaken = true;
      }
    }
    return signals;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async updateState(_state: MarketState): Promise<void> {
    /* No additional bookkeeping; per-bar state lives in dayState. */
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onPositionEvent(ev: PositionEvent): Promise<void> {
    if (ev.type === "opened" || ev.type === "modified") {
      if (this.mine.has(ev.position.id) || ev.position.originatingStrategy === this.name) {
        this.openByInstrument.set(ev.position.instrument, ev.position);
        this.mine.add(ev.position.id);
      }
      return;
    }
    if (ev.type === "closed") {
      this.openByInstrument.delete(ev.position.instrument);
      this.mine.delete(ev.position.id);
    }
  }

  getOpenPositions(): Position[] {
    return [...this.openByInstrument.values()];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async shutdown(): Promise<void> {
    /* nothing to flush; per-bar state isn't persisted by the strategy. */
  }

  // ------------------------------------------------------- sweep mechanics

  private tryLong(day: DayState, bar: Bar, atr14: number): Signal | null {
    if (day.lowSweepState === "idle") {
      if (bar.low < day.asianLow) {
        const depth = (day.asianLow - bar.low) / atr14;
        if (depth < this.params.minSweepAtr) {
          return null;
        }
        if (depth > this.params.maxSweepAtr) {
          day.lowSweepState = "abandoned";
          return null;
        }
        day.lowSweepState = "breached";
        day.lowBreachExtreme = bar.low;
        day.lowBreachAtBar = day.barIndex;
      }
      return null;
    }
    if (day.lowSweepState !== "breached") {
      return null;
    }
    // breached -> deeper or aged out or reversal candle?
    if (bar.low < day.lowBreachExtreme) {
      day.lowBreachExtreme = bar.low;
      if ((day.asianLow - day.lowBreachExtreme) / atr14 > this.params.maxSweepAtr) {
        day.lowSweepState = "abandoned";
        return null;
      }
    }
    const barsSinceBreach = day.barIndex - day.lowBreachAtBar;
    if (barsSinceBreach > this.params.sweepMaxBars) {
      day.lowSweepState = "abandoned";
      return null;
    }
    if (bar.close > day.asianLow && barsSinceBreach > 0) {
      // Reversal candle: bullish body taking close back above AL.
      const body = bar.close - bar.open;
      const range = bar.high - bar.low;
      if (range > 0 && body > 0 && body / range >= this.params.displacementRatio) {
        const entry = bar.close;
        const stop = day.lowBreachExtreme - this.params.stopBufferPips * pipSizeFor(this.instrument);
        const target = entry + this.params.targetR * (entry - stop);
        return this.buildSignal(bar, "long", entry, stop, target);
      }
    }
    return null;
  }

  private tryShort(day: DayState, bar: Bar, atr14: number): Signal | null {
    if (day.highSweepState === "idle") {
      if (bar.high > day.asianHigh) {
        const depth = (bar.high - day.asianHigh) / atr14;
        if (depth < this.params.minSweepAtr) {
          return null;
        }
        if (depth > this.params.maxSweepAtr) {
          day.highSweepState = "abandoned";
          return null;
        }
        day.highSweepState = "breached";
        day.highBreachExtreme = bar.high;
        day.highBreachAtBar = day.barIndex;
      }
      return null;
    }
    if (day.highSweepState !== "breached") {
      return null;
    }
    if (bar.high > day.highBreachExtreme) {
      day.highBreachExtreme = bar.high;
      if (
        (day.highBreachExtreme - day.asianHigh) / atr14 >
        this.params.maxSweepAtr
      ) {
        day.highSweepState = "abandoned";
        return null;
      }
    }
    const barsSinceBreach = day.barIndex - day.highBreachAtBar;
    if (barsSinceBreach > this.params.sweepMaxBars) {
      day.highSweepState = "abandoned";
      return null;
    }
    if (bar.close < day.asianHigh && barsSinceBreach > 0) {
      const body = bar.open - bar.close; // bearish body
      const range = bar.high - bar.low;
      if (range > 0 && body > 0 && body / range >= this.params.displacementRatio) {
        const entry = bar.close;
        const stop = day.highBreachExtreme + this.params.stopBufferPips * pipSizeFor(this.instrument);
        const target = entry - this.params.targetR * (stop - entry);
        return this.buildSignal(bar, "short", entry, stop, target);
      }
    }
    return null;
  }

  private buildSignal(
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
      urgencyScore: 0.7,
      signalType: `asian_sweep_${direction}`,
      entryReason: `Asian-range sweep reversal at ${bar.timestampUtc.toISOString()}`,
      generatedAtBar: bar.timestampUtc,
      metadata: {
        params: this.params,
      },
    };
  }
}
