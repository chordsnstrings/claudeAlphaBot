/**
 * Tick-to-bar aggregator.
 *
 * Used by the CTraderDataFeed to convert the cTrader Open API spot stream
 * into the engine's Bar shape. Tracks the current bar per (instrument,
 * timeframe), emits a finalized Bar each time the period boundary is
 * crossed.
 *
 * The aggregator is timeframe-agnostic and timestamps bars by the START
 * of their period (consistent with the historical bars from the DB).
 */

import type { Bar, Timeframe } from "@trading/core";

export interface Tick {
  instrument: string;
  /** Mid-price or bid; the spec is silent so we use the supplied value as-is. */
  price: number;
  /** Tick volume contribution; default 1 if unknown. */
  volume?: number;
  timestampUtc: Date;
}

export function periodMs(tf: Timeframe): number {
  switch (tf) {
    case "m1":
      return 60_000;
    case "m5":
      return 5 * 60_000;
    case "h1":
      return 3_600_000;
    case "d1":
      return 86_400_000;
    default: {
      const exhaustive: never = tf;
      throw new Error(`unhandled timeframe ${String(exhaustive)}`);
    }
  }
}

export function periodStart(timestamp: Date, tf: Timeframe): Date {
  const ms = timestamp.getTime();
  const p = periodMs(tf);
  return new Date(Math.floor(ms / p) * p);
}

interface BuildingBar {
  instrument: string;
  timeframe: Timeframe;
  periodStartMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Stateful tick-to-bar aggregator. Call `onTick(tick, timeframe)` per
 * incoming tick; the aggregator returns the just-finalized Bar when the
 * tick crosses into a new period, or null otherwise.
 *
 * For multi-timeframe streaming, use one TickToBarBuilder per pair, or
 * the multi-TF helper at the bottom.
 */
export class TickToBarBuilder {
  private readonly current = new Map<string, BuildingBar>();

  /**
   * Returns the FINALIZED bar of the prior period if the tick crossed
   * into a new period. Returns null otherwise. The just-arrived tick is
   * folded into the new period's building bar either way.
   */
  onTick(tick: Tick, timeframe: Timeframe): Bar | null {
    const key = `${tick.instrument}|${timeframe}`;
    const startMs = periodStart(tick.timestampUtc, timeframe).getTime();
    const existing = this.current.get(key);
    if (existing === undefined) {
      this.current.set(key, this.startBar(tick, timeframe, startMs));
      return null;
    }
    if (existing.periodStartMs === startMs) {
      // Same period — fold in.
      if (tick.price > existing.high) {
        existing.high = tick.price;
      }
      if (tick.price < existing.low) {
        existing.low = tick.price;
      }
      existing.close = tick.price;
      existing.volume += tick.volume ?? 1;
      return null;
    }
    // New period: finalize the previous one and start a new one.
    const finalized = this.toBar(existing);
    this.current.set(key, this.startBar(tick, timeframe, startMs));
    return finalized;
  }

  /**
   * Force-finalise all open bars (e.g. on stream end / disconnect).
   * Useful when a backfill needs to settle before the next subscription.
   */
  flushAll(): Bar[] {
    const out: Bar[] = [];
    for (const b of this.current.values()) {
      out.push(this.toBar(b));
    }
    this.current.clear();
    return out;
  }

  /** Most-recent building bar (still open) for a pair, if any. */
  peek(instrument: string, timeframe: Timeframe): Bar | null {
    const b = this.current.get(`${instrument}|${timeframe}`);
    return b === undefined ? null : this.toBar(b);
  }

  private startBar(tick: Tick, tf: Timeframe, startMs: number): BuildingBar {
    return {
      instrument: tick.instrument,
      timeframe: tf,
      periodStartMs: startMs,
      open: tick.price,
      high: tick.price,
      low: tick.price,
      close: tick.price,
      volume: tick.volume ?? 1,
    };
  }

  private toBar(b: BuildingBar): Bar {
    return {
      instrument: b.instrument,
      timeframe: b.timeframe,
      timestampUtc: new Date(b.periodStartMs),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      source: "live",
    };
  }
}
