/**
 * Historical 1h kline loader.
 *
 * Paginates `/fapi/v1/klines` in 1000-candle pages (Binance max) and
 * upserts into the `candles` table. Idempotent and resumable:
 *
 *   - If candles already exist for `(symbol, open_time)`, they are
 *     left unchanged (ON CONFLICT DO NOTHING).
 *   - Resume from `MAX(open_time)+1ms` already stored for the symbol,
 *     so re-running a broken load picks up where it left off.
 *
 * Pacing: 300ms between pages. Binance futures REST allows 2400 weight
 * per minute; klines with `limit=1000` costs 10 weight → at 200 pages
 * per minute that's 2000 weight, under the cap. 300ms pace + retry
 * jitter keeps us well below the limit.
 *
 * Gap detection: after load, counts hourly gaps by scanning the
 * (open_time) sequence for deltas != 3_600_000 ms. Reports but does
 * not retry automatically — caller decides.
 */
import type pg from "pg";

import type { Symbol as TradingSymbol } from "@hydra/shared";

import { BinanceRestClient, type ParsedKline } from "./binance-rest.js";

const HOUR_MS = 3_600_000;
const DEFAULT_MONTHS = 24;
const PAGE_SIZE = 1000;
const DEFAULT_PACE_MS = 300;

export interface LoadHistoricalOptions {
  readonly symbol: TradingSymbol;
  readonly pool: pg.Pool;
  readonly client: BinanceRestClient;
  readonly months?: number;
  readonly startTime?: number;
  readonly endTime?: number;
  readonly paceMs?: number;
  readonly onProgress?: (p: { page: number; fetched: number; inserted: number; lastOpenTime: number }) => void;
}

export interface LoadHistoricalResult {
  readonly symbol: TradingSymbol;
  readonly fetched: number;
  readonly inserted: number;
  readonly pages: number;
  readonly firstOpenTime: number | null;
  readonly lastOpenTime: number | null;
  readonly gapCount: number;
}

export async function loadHistoricalCandles(opts: LoadHistoricalOptions): Promise<LoadHistoricalResult> {
  const { symbol, pool, client } = opts;
  const endTime = opts.endTime ?? floorToHour(Date.now());
  const months = opts.months ?? DEFAULT_MONTHS;

  // Resume: if we have prior rows, start just past the newest stored candle
  const startFromDb = await getMaxOpenTime(pool, symbol);
  const requestedStart = opts.startTime ?? endTime - months * 30 * 24 * HOUR_MS;
  const startTime = startFromDb !== null ? Math.max(requestedStart, startFromDb + HOUR_MS) : requestedStart;

  const paceMs = opts.paceMs ?? DEFAULT_PACE_MS;
  let cursor = startTime;
  let page = 0;
  let fetched = 0;
  let inserted = 0;
  let firstOpenTime: number | null = null;
  let lastOpenTime: number | null = null;

  while (cursor < endTime) {
    page += 1;
    const batch = await client.getKlines({
      symbol,
      interval: "1h",
      startTime: cursor,
      endTime,
      limit: PAGE_SIZE,
    });

    if (batch.length === 0) break;

    const insertedInBatch = await upsertCandles(pool, batch);
    fetched += batch.length;
    inserted += insertedInBatch;

    const firstInBatch = batch[0];
    const lastInBatch = batch[batch.length - 1];
    if (firstInBatch && firstOpenTime === null) firstOpenTime = firstInBatch.openTime;
    if (lastInBatch) lastOpenTime = lastInBatch.openTime;

    if (opts.onProgress && lastInBatch) {
      opts.onProgress({ page, fetched, inserted, lastOpenTime: lastInBatch.openTime });
    }

    // Advance. If Binance returned fewer than PAGE_SIZE rows, we've
    // reached the tail of available data.
    if (batch.length < PAGE_SIZE || !lastInBatch) break;
    cursor = lastInBatch.openTime + HOUR_MS;

    if (paceMs > 0) await sleep(paceMs);
  }

  const gapCount = await countGaps(pool, symbol, firstOpenTime, lastOpenTime);

  return {
    symbol,
    fetched,
    inserted,
    pages: page,
    firstOpenTime,
    lastOpenTime,
    gapCount,
  };
}

async function getMaxOpenTime(pool: pg.Pool, symbol: TradingSymbol): Promise<number | null> {
  const res = await pool.query<{ max: string | null }>(
    "SELECT MAX(open_time)::text AS max FROM candles WHERE symbol = $1",
    [symbol],
  );
  const row = res.rows[0];
  if (!row || row.max === null) return null;
  const n = Number(row.max);
  return Number.isFinite(n) ? n : null;
}

/**
 * Upsert a batch of candles. Returns the number of NEW rows inserted
 * (conflicts are treated as "already there").
 */
async function upsertCandles(pool: pg.Pool, batch: readonly ParsedKline[]): Promise<number> {
  if (batch.length === 0) return 0;

  const values: unknown[] = [];
  const placeholders: string[] = [];
  batch.forEach((c, i) => {
    const o = i * 8;
    placeholders.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8})`);
    values.push(c.symbol, c.openTime, c.closeTime, c.open, c.high, c.low, c.close, c.volume);
  });

  const sql = `
    INSERT INTO candles (symbol, open_time, close_time, open, high, low, close, volume)
    VALUES ${placeholders.join(", ")}
    ON CONFLICT (symbol, open_time) DO NOTHING
  `;
  const res = await pool.query(sql, values);
  return res.rowCount ?? 0;
}

async function countGaps(
  pool: pg.Pool,
  symbol: TradingSymbol,
  fromMs: number | null,
  toMs: number | null,
): Promise<number> {
  if (fromMs === null || toMs === null || fromMs >= toMs) return 0;

  const res = await pool.query<{ gaps: string }>(
    `
      WITH ordered AS (
        SELECT open_time,
               LAG(open_time) OVER (ORDER BY open_time) AS prev
        FROM candles
        WHERE symbol = $1
          AND open_time BETWEEN $2 AND $3
      )
      SELECT COUNT(*)::text AS gaps
      FROM ordered
      WHERE prev IS NOT NULL AND (open_time - prev) <> ${HOUR_MS}
    `,
    [symbol, fromMs, toMs],
  );
  const row = res.rows[0];
  return row ? Number(row.gaps) : 0;
}

function floorToHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const __testing__ = { upsertCandles, countGaps, HOUR_MS };
