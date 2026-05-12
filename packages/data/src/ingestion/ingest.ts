/**
 * ingest(instrument, timeframe, from, to) — pulls historical bars from
 * Dukascopy via `dukascopy-node` and bulk-inserts them with
 * ON CONFLICT DO NOTHING. Idempotent re-runs are explicitly supported.
 *
 * Spec section 9.3.
 */

import { logger } from "@trading/core";
import { getHistoricalRates, type Instrument as DukasInstrument } from "dukascopy-node";

import type { Repos } from "../repos/index.js";
import type { NewBarRow } from "../schema/bar.js";
import { resolve } from "./instrument-map.js";

const log = logger("data.ingest");

export type IngestTimeframe = "m1" | "m5" | "h1" | "d1";

export interface IngestParams {
  instrument: string;
  timeframe: IngestTimeframe;
  from: Date;
  to: Date;
  /** Default 3. */
  maxRetries?: number;
  /** Override the progress reporting frequency (rows). */
  progressEvery?: number;
}

export interface IngestResult {
  instrument: string;
  canonical: string;
  timeframe: IngestTimeframe;
  fetched: number;
  inserted: number;
  skipped: number;
  status: "ok" | "skipped_unavailable" | "no_data" | "error";
  error?: string;
  durationMs: number;
}

/** Map our timeframe codes to the dukascopy-node literal strings. */
const TIMEFRAME_TO_DUKAS: Record<IngestTimeframe, "m1" | "m5" | "h1" | "d1"> = {
  m1: "m1",
  m5: "m5",
  h1: "h1",
  d1: "d1",
};

const DEFAULT_PROGRESS_EVERY: Record<IngestTimeframe, number> = {
  m1: 1000,
  m5: 1000,
  h1: 500,
  d1: 100,
};

/** Sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    setTimeout(res, ms);
  });
}

/**
 * Wrap a single getHistoricalRates call with exponential-backoff retry.
 * Errors include transient network blips and Dukascopy 5xx; the library
 * itself does some retry internally, but we add another layer.
 */
async function fetchWithRetry(
  dukasCode: string,
  timeframe: IngestTimeframe,
  from: Date,
  to: Date,
  maxRetries: number,
): Promise<unknown[]> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      // dukascopy-node types its instrument param as a closed string union of
      // 1600+ codes. We resolve dynamically; cast through DukasInstrument.
      // The format/priceType fields are typed as string literals in the
      // overload selector, not the Format/Price enums, so pass the literals.
      const data = (await getHistoricalRates({
        instrument: dukasCode as DukasInstrument,
        dates: { from, to },
        timeframe: TIMEFRAME_TO_DUKAS[timeframe],
        format: "array",
        priceType: "bid",
        utcOffset: 0,
        ignoreFlats: true,
      })) as unknown[];
      return Array.isArray(data) ? data : [];
    } catch (err) {
      lastErr = err;
      const wait = 1500 * 2 ** (attempt - 1);
      log.warn(
        { dukasCode, timeframe, attempt, maxRetries, wait, err: errMsg(err) },
        "fetch failed, retrying after backoff",
      );
      if (attempt < maxRetries) {
        await sleep(wait);
      }
    }
  }
  throw new Error(`Dukascopy fetch failed after ${maxRetries} retries: ${errMsg(lastErr)}`);
}

function errMsg(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Map a single Dukascopy row (array form: [tsMs, open, high, low, close, volume])
 * into a Bar insert row. Volume from Dukascopy is tick volume, not real volume.
 */
function toBarRow(
  rec: unknown,
  canonical: string,
  timeframe: IngestTimeframe,
): NewBarRow | null {
  if (!Array.isArray(rec) || rec.length < 6) {
    return null;
  }
  const [tsMs, o, h, l, c, v] = rec as [number, number, number, number, number, number];
  if (![tsMs, o, h, l, c, v].every((x) => Number.isFinite(x))) {
    return null;
  }
  return {
    instrument: canonical,
    timeframe,
    timestampUtc: new Date(tsMs),
    open: o.toFixed(6),
    high: h.toFixed(6),
    low: l.toFixed(6),
    close: c.toFixed(6),
    volume: v.toFixed(2),
    source: "historical",
  };
}

const INSERT_BATCH_SIZE = 2000;

export async function ingest(
  repos: Repos,
  params: IngestParams,
): Promise<IngestResult> {
  const started = Date.now();
  const { instrument, timeframe, from, to } = params;
  const maxRetries = params.maxRetries ?? 3;
  const progressEvery = params.progressEvery ?? DEFAULT_PROGRESS_EVERY[timeframe];

  const r = resolve(instrument);
  if (r.dukascopy === null) {
    log.warn(
      { instrument: r.canonical },
      "instrument not available in Dukascopy; skipping",
    );
    await repos.validation.insert({
      instrument: r.canonical,
      timeframe,
      issueType: "unavailable_instrument",
      severity: "info",
      description: `Symbol not carried by Dukascopy; spec 14 calls for skip-and-log.`,
      affectedTimeRangeStart: from,
      affectedTimeRangeEnd: to,
    });
    return {
      instrument,
      canonical: r.canonical,
      timeframe,
      fetched: 0,
      inserted: 0,
      skipped: 0,
      status: "skipped_unavailable",
      durationMs: Date.now() - started,
    };
  }

  log.info(
    { instrument: r.canonical, timeframe, from: from.toISOString(), to: to.toISOString() },
    "starting ingest",
  );

  let raw: unknown[];
  try {
    raw = await fetchWithRetry(r.dukascopy, timeframe, from, to, maxRetries);
  } catch (err) {
    log.error(
      { instrument: r.canonical, timeframe, err: errMsg(err) },
      "ingest failed",
    );
    return {
      instrument,
      canonical: r.canonical,
      timeframe,
      fetched: 0,
      inserted: 0,
      skipped: 0,
      status: "error",
      error: errMsg(err),
      durationMs: Date.now() - started,
    };
  }

  log.info({ instrument: r.canonical, timeframe, rows: raw.length }, "fetch complete");

  if (raw.length === 0) {
    return {
      instrument,
      canonical: r.canonical,
      timeframe,
      fetched: 0,
      inserted: 0,
      skipped: 0,
      status: "no_data",
      durationMs: Date.now() - started,
    };
  }

  let inserted = 0;
  let skipped = 0;
  let batch: NewBarRow[] = [];
  let processed = 0;
  for (const rec of raw) {
    const row = toBarRow(rec, r.canonical, timeframe);
    if (row === null) {
      skipped += 1;
      continue;
    }
    batch.push(row);
    if (batch.length >= INSERT_BATCH_SIZE) {
      inserted += await repos.bars.insertMany(batch);
      batch = [];
    }
    processed += 1;
    if (processed % progressEvery === 0) {
      log.info(
        { instrument: r.canonical, timeframe, processed, inserted, of: raw.length },
        "progress",
      );
    }
  }
  if (batch.length > 0) {
    inserted += await repos.bars.insertMany(batch);
  }

  log.info(
    {
      instrument: r.canonical,
      timeframe,
      fetched: raw.length,
      inserted,
      skipped,
      durationMs: Date.now() - started,
    },
    "ingest complete",
  );

  return {
    instrument,
    canonical: r.canonical,
    timeframe,
    fetched: raw.length,
    inserted,
    skipped,
    status: "ok",
    durationMs: Date.now() - started,
  };
}
