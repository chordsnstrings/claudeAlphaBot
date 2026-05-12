/**
 * ingest:incremental — for each (instrument, timeframe) pair, query the
 * latest bar in the DB and ingest from there forward to now (or the
 * configured "to" if given). Used to keep the DB current without
 * re-pulling history.
 */

import { logger } from "@trading/core";
import {
  FULL_DAILY_UNIVERSE,
  M1_UNIVERSE,
  ingest,
  reportForPair,
  type IngestResult,
  type IngestTimeframe,
} from "@trading/data";

import { buildContext } from "./context.js";

const log = logger("cli.ingest-incremental");

export interface IncrementalOpts {
  /** Override the "to" boundary; defaults to now (UTC). */
  to?: string;
  /** Override timeframes to refresh; defaults to ['d1','m1']. */
  timeframes?: IngestTimeframe[];
}

export async function runIngestIncremental(opts: IncrementalOpts = {}): Promise<number> {
  const ctx = buildContext();
  const toDate =
    opts.to !== undefined ? new Date(`${opts.to}T00:00:00Z`) : new Date();
  const timeframes = opts.timeframes ?? ["d1", "m1"];
  const overall: IngestResult[] = [];
  let exit = 0;
  try {
    for (const tf of timeframes) {
      const universe = tf === "d1" ? FULL_DAILY_UNIVERSE : M1_UNIVERSE;
      for (const instrument of universe) {
        const existing = await reportForPair(ctx.db, instrument, tf);
        const from = existing.lastBar ?? new Date("2020-01-01T00:00:00Z");
        if (from >= toDate) {
          log.info({ instrument, timeframe: tf, from, to: toDate }, "already current; skip");
          continue;
        }
        const r = await ingest(ctx.repos, { instrument, timeframe: tf, from, to: toDate });
        overall.push(r);
        if (r.status === "error") {
          exit = 1;
        }
      }
    }
    log.info(
      { results: overall.length, errors: overall.filter((r) => r.status === "error").length },
      "ingest:incremental done",
    );
    return exit;
  } finally {
    await ctx.close();
  }
}
