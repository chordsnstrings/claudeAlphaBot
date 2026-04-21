/**
 * Funding rate history loader.
 *
 * Paginates `/fapi/v1/fundingRate` (max 1000 rows per call) and upserts
 * into `funding_rates`. Funding is published every 8 hours so 3 months
 * yields ~270 rows per symbol and 24 months yields ~2,200.
 *
 * Resume: starts from `MAX(funding_time)+1ms` stored for the symbol.
 */
import type pg from "pg";

import type { Symbol as TradingSymbol } from "@hydra/shared";

import { BinanceRestClient, type ParsedFundingRate } from "./binance-rest.js";

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
const DEFAULT_MONTHS = 24;
const PAGE_SIZE = 1000;
const DEFAULT_PACE_MS = 300;

export interface LoadFundingOptions {
  readonly symbol: TradingSymbol;
  readonly pool: pg.Pool;
  readonly client: BinanceRestClient;
  readonly months?: number;
  readonly startTime?: number;
  readonly endTime?: number;
  readonly paceMs?: number;
}

export interface LoadFundingResult {
  readonly symbol: TradingSymbol;
  readonly fetched: number;
  readonly inserted: number;
  readonly pages: number;
}

export async function loadFundingRates(opts: LoadFundingOptions): Promise<LoadFundingResult> {
  const { symbol, pool, client } = opts;
  const endTime = opts.endTime ?? Date.now();
  const months = opts.months ?? DEFAULT_MONTHS;

  const stored = await getMaxFundingTime(pool, symbol);
  const requestedStart = opts.startTime ?? endTime - months * 30 * 24 * 60 * 60 * 1000;
  const startTime = stored !== null ? Math.max(requestedStart, stored + 1) : requestedStart;

  const paceMs = opts.paceMs ?? DEFAULT_PACE_MS;
  let cursor = startTime;
  let page = 0;
  let fetched = 0;
  let inserted = 0;

  while (cursor < endTime) {
    page += 1;
    const batch = await client.getFundingRateHistory({
      symbol,
      startTime: cursor,
      endTime,
      limit: PAGE_SIZE,
    });

    if (batch.length === 0) break;

    const insertedInBatch = await upsertFunding(pool, batch);
    fetched += batch.length;
    inserted += insertedInBatch;

    const last = batch[batch.length - 1];
    if (batch.length < PAGE_SIZE || !last) break;
    cursor = last.fundingTime + 1;

    if (paceMs > 0) await sleep(paceMs);
  }

  // Safety: advance past any infinite-loop risk where Binance returns
  // only one row repeatedly. The pagination above already guards by
  // advancing `cursor` — if `last.fundingTime + 1` equals a prior
  // value, the next call would return duplicates which are ON CONFLICT
  // NO-OP, and then the < PAGE_SIZE termination will kick in.

  return { symbol, fetched, inserted, pages: page };
}

async function getMaxFundingTime(pool: pg.Pool, symbol: TradingSymbol): Promise<number | null> {
  const res = await pool.query<{ max: string | null }>(
    "SELECT MAX(funding_time)::text AS max FROM funding_rates WHERE symbol = $1",
    [symbol],
  );
  const row = res.rows[0];
  if (!row || row.max === null) return null;
  const n = Number(row.max);
  return Number.isFinite(n) ? n : null;
}

async function upsertFunding(pool: pg.Pool, batch: readonly ParsedFundingRate[]): Promise<number> {
  if (batch.length === 0) return 0;

  const values: unknown[] = [];
  const placeholders: string[] = [];
  batch.forEach((r, i) => {
    const o = i * 3;
    placeholders.push(`($${o + 1}, $${o + 2}, $${o + 3})`);
    values.push(r.symbol, r.fundingTime, r.fundingRate);
  });

  const sql = `
    INSERT INTO funding_rates (symbol, funding_time, funding_rate)
    VALUES ${placeholders.join(", ")}
    ON CONFLICT (symbol, funding_time) DO NOTHING
  `;
  const res = await pool.query(sql, values);
  return res.rowCount ?? 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const __testing__ = { upsertFunding, EIGHT_HOURS_MS };
