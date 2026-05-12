/**
 * HistoricalDataFeed — backtest-mode {@link MarketDataFeed}.
 *
 * Spec: trading_system_docs.md section 9.6.
 *
 * Reads bars from TimescaleDB and yields them per (instrument, timeframe).
 * Across the whole subscription set, bars are produced in strict
 * chronological order so multi-instrument backtests see the same
 * timeline a live engine would.
 *
 * Streaming model:
 *   - One background "producer" task issues keyset-paginated SELECTs
 *     over the `bar` table, ordered by `(timestamp_utc, instrument,
 *     timeframe)`. Each page is at most `pageSize` rows (default 5000).
 *   - Rows are dispatched into per-pair {@link AsyncQueue}s — these
 *     give the producer backpressure when consumers fall behind.
 *   - Each consumer's `subscribe(instr, tf)` returns an AsyncIterable
 *     that drains its queue, applying the clock-no-lookahead gate just
 *     before yielding.
 *
 * No-lookahead gate (spec §3.9): before yielding bar B to a consumer the
 * iterator polls `clock.now() >= B.timestampUtc`, sleeping `clockPollMs`
 * between checks. In backtest the SimulatedClock (Phase 8) advances on
 * bar processing so the gate rarely waits; in test fixtures the gate
 * holds the iterator at the configured clock time, which is exactly the
 * verification surface the spec calls for.
 */

import { logger, type Bar, type Clock, type MarketDataFeed, type Timeframe } from "@trading/core";
import type { Db } from "@trading/data";
import type pg from "pg";

import { AsyncQueue } from "./async-queue.js";

const log = logger("adapters.historical-data-feed");

const DEFAULT_PAGE_SIZE = 5000;
const DEFAULT_QUEUE_CAPACITY = 1000;
const DEFAULT_CLOCK_POLL_MS = 10;

export interface HistoricalDataFeedConfig {
  instruments: string[];
  timeframes: Timeframe[];
  /** Inclusive lower bound (timestamp_utc >= from). */
  from: Date;
  /** Inclusive upper bound (timestamp_utc <= to). */
  to: Date;
  /** Keyset page size; default 5000. */
  pageSize?: number;
  /** Per-pair queue capacity; default 1000. */
  queueCapacity?: number;
  /** Clock-gate poll interval; default 10 ms. */
  clockPollMs?: number;
}

interface HistoricalDataFeedDeps {
  db: Db;
  pool: pg.Pool;
  clock: Clock;
}

interface DbBarRow {
  instrument: string;
  timeframe: string;
  timestamp_utc: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  source: string;
}

function pairKey(instrument: string, timeframe: Timeframe): string {
  return `${instrument}|${timeframe}`;
}

function rowToBar(row: DbBarRow): Bar {
  // pg returns timestamptz as a Date when its default parser is registered,
  // but the raw pool path can hand back ISO strings depending on which
  // parser overrides Drizzle / pg-types have installed. Normalise either way.
  const ts = row.timestamp_utc as unknown;
  const tsDate = ts instanceof Date ? ts : new Date(String(ts));
  return {
    instrument: row.instrument,
    timeframe: row.timeframe as Timeframe,
    timestampUtc: tsDate,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
    source: row.source as Bar["source"],
  };
}

export class HistoricalDataFeed implements MarketDataFeed {
  private connected = false;
  private stopRequested = false;
  private producerPromise: Promise<void> | null = null;
  private readonly queues = new Map<string, AsyncQueue<Bar>>();
  private readonly currentBars = new Map<string, Bar>();
  private readonly pageSize: number;
  private readonly queueCapacity: number;
  private readonly clockPollMs: number;

  constructor(
    private readonly deps: HistoricalDataFeedDeps,
    private readonly config: HistoricalDataFeedConfig,
  ) {
    if (config.instruments.length === 0) {
      throw new Error("HistoricalDataFeed: at least one instrument is required");
    }
    if (config.timeframes.length === 0) {
      throw new Error("HistoricalDataFeed: at least one timeframe is required");
    }
    if (config.from > config.to) {
      throw new Error(
        `HistoricalDataFeed: from (${config.from.toISOString()}) must be <= to (${config.to.toISOString()})`,
      );
    }
    this.pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
    this.queueCapacity = config.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
    this.clockPollMs = config.clockPollMs ?? DEFAULT_CLOCK_POLL_MS;
  }

  async start(): Promise<void> {
    if (this.connected) {
      return;
    }
    for (const instrument of this.config.instruments) {
      for (const tf of this.config.timeframes) {
        this.queues.set(pairKey(instrument, tf), new AsyncQueue<Bar>(this.queueCapacity));
      }
    }
    this.connected = true;
    this.stopRequested = false;
    this.producerPromise = this.produce().catch((err) => {
      log.error({ err: err instanceof Error ? err.stack : String(err) }, "producer failed");
      // Close all queues so consumers don't hang.
      for (const q of this.queues.values()) {
        q.close();
      }
      throw err;
    });
    log.info(
      {
        instruments: this.config.instruments,
        timeframes: this.config.timeframes,
        from: this.config.from,
        to: this.config.to,
      },
      "historical data feed started",
    );
  }

  async stop(): Promise<void> {
    if (!this.connected) {
      return;
    }
    this.stopRequested = true;
    for (const q of this.queues.values()) {
      q.close();
    }
    if (this.producerPromise !== null) {
      await this.producerPromise.catch(() => undefined);
    }
    this.connected = false;
    log.info("historical data feed stopped");
  }

  isConnected(): boolean {
    return this.connected;
  }

  getCurrentBar(instrument: string, timeframe: Timeframe): Bar | null {
    return this.currentBars.get(pairKey(instrument, timeframe)) ?? null;
  }

  async getHistoricalBars(
    instrument: string,
    timeframe: Timeframe,
    from: Date,
    to: Date,
  ): Promise<Bar[]> {
    const result = await this.deps.pool.query<DbBarRow>(
      `SELECT instrument, timeframe, timestamp_utc, open, high, low, close, volume, source
         FROM bar
        WHERE instrument = $1 AND timeframe = $2
          AND timestamp_utc >= $3 AND timestamp_utc <= $4
        ORDER BY timestamp_utc`,
      [instrument, timeframe, from, to],
    );
    return result.rows.map(rowToBar);
  }

  async *subscribe(instrument: string, timeframe: Timeframe): AsyncIterable<Bar> {
    const key = pairKey(instrument, timeframe);
    const q = this.queues.get(key);
    if (q === undefined) {
      throw new Error(
        `HistoricalDataFeed.subscribe: ${key} is not in the configured set ` +
          `[${this.config.instruments.join(",")}] x [${this.config.timeframes.join(",")}]`,
      );
    }
    while (true) {
      const bar = await q.next();
      if (bar === null) {
        return;
      }
      // No-lookahead gate.
      while (bar.timestampUtc.getTime() > this.deps.clock.now().getTime()) {
        if (this.stopRequested) {
          return;
        }
        await this.deps.clock.sleep(this.clockPollMs);
      }
      this.currentBars.set(key, bar);
      yield bar;
    }
  }

  // ----------------------------------------------------------- internals

  private async produce(): Promise<void> {
    // Build the (instrument, timeframe) IN tuple list once.
    const tuples = this.config.instruments.flatMap((inst) =>
      this.config.timeframes.map((tf) => ({ instrument: inst, timeframe: tf })),
    );

    // Keyset state.
    let lastTs: Date | null = null;
    let lastInst: string | null = null;
    let lastTf: string | null = null;

    while (!this.stopRequested) {
      // Build the SQL params: pair tuples, range bounds, optional keyset, pageSize.
      const params: unknown[] = [];
      const tupleSql = tuples
        .map((t) => {
          params.push(t.instrument, t.timeframe);
          return `($${params.length - 1}, $${params.length})`;
        })
        .join(", ");

      params.push(this.config.from);
      const fromParam = params.length;
      params.push(this.config.to);
      const toParam = params.length;

      let keysetClause = "";
      if (lastTs !== null) {
        params.push(lastTs, lastInst, lastTf);
        const a = params.length - 2;
        const b = params.length - 1;
        const c = params.length;
        keysetClause = `AND (timestamp_utc, instrument, timeframe) > ($${a}, $${b}, $${c})`;
      }

      params.push(this.pageSize);
      const limitParam = params.length;

      const sqlText =
        `SELECT instrument, timeframe, timestamp_utc, open, high, low, close, volume, source
           FROM bar
          WHERE (instrument, timeframe) IN (${tupleSql})
            AND timestamp_utc >= $${fromParam}
            AND timestamp_utc <= $${toParam}
            ${keysetClause}
          ORDER BY timestamp_utc, instrument, timeframe
          LIMIT $${limitParam}`;

      const result = await this.deps.pool.query<DbBarRow>(sqlText, params);
      const rows = result.rows;
      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        if (this.stopRequested) {
          return;
        }
        const bar = rowToBar(row);
        const key = pairKey(bar.instrument, bar.timeframe as Timeframe);
        const q = this.queues.get(key);
        if (q === undefined) {
          // Tuple list and queue set should always agree; defensive only.
          continue;
        }
        await q.push(bar);
      }

      const last = rows[rows.length - 1];
      if (last !== undefined) {
        lastTs = last.timestamp_utc;
        lastInst = last.instrument;
        lastTf = last.timeframe;
      }

      if (rows.length < this.pageSize) {
        break;
      }
    }

    // Done — close all queues so consumers complete.
    for (const q of this.queues.values()) {
      q.close();
    }
  }
}
