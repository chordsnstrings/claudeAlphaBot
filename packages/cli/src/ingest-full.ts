/**
 * ingest:full — default ingestion run per spec section 9.3:
 *   - Daily 2020-01-01 → 2026-05-12 for the full instrument universe
 *   - M1 2025-11-01 → 2026-05-12 for the active trading subset
 *
 * Runs ingest sequentially per instrument so we don't hammer Dukascopy's
 * free feed. Failures on individual instruments are logged but do not
 * abort the whole run; the operator can re-run idempotently for any that
 * failed.
 */

import { logger } from "@trading/core";
import {
  DEFAULT_DAILY_FROM,
  DEFAULT_DAILY_TO,
  DEFAULT_M1_FROM,
  DEFAULT_M1_TO,
  FULL_DAILY_UNIVERSE,
  M1_UNIVERSE,
  ingest,
  reportAll,
  type IngestResult,
} from "@trading/data";

import { buildContext } from "./context.js";

const log = logger("cli.ingest-full");

export async function runIngestFull(): Promise<number> {
  const ctx = buildContext();
  const overall: IngestResult[] = [];
  let exit = 0;
  try {
    log.info(
      {
        dailyCount: FULL_DAILY_UNIVERSE.length,
        m1Count: M1_UNIVERSE.length,
        dailyRange: [DEFAULT_DAILY_FROM, DEFAULT_DAILY_TO],
        m1Range: [DEFAULT_M1_FROM, DEFAULT_M1_TO],
      },
      "ingest:full starting",
    );

    for (const instrument of FULL_DAILY_UNIVERSE) {
      const r = await ingest(ctx.repos, {
        instrument,
        timeframe: "d1",
        from: DEFAULT_DAILY_FROM,
        to: DEFAULT_DAILY_TO,
      });
      overall.push(r);
      if (r.status === "error") {
        exit = 1;
      }
    }

    for (const instrument of M1_UNIVERSE) {
      const r = await ingest(ctx.repos, {
        instrument,
        timeframe: "m1",
        from: DEFAULT_M1_FROM,
        to: DEFAULT_M1_TO,
      });
      overall.push(r);
      if (r.status === "error") {
        exit = 1;
      }
    }

    // Final report.
    const pairs: Array<{ instrument: string; timeframe: "m1" | "d1" }> = [
      ...FULL_DAILY_UNIVERSE.map((i: string) => ({ instrument: i, timeframe: "d1" as const })),
      ...M1_UNIVERSE.map((i: string) => ({ instrument: i, timeframe: "m1" as const })),
    ];
    const report = await reportAll(ctx.db, pairs);
    log.info(
      {
        instruments: report.length,
        totals: report.reduce((acc: number, r) => acc + r.rows, 0),
        details: report,
      },
      "ingest:full report",
    );

    return exit;
  } finally {
    await ctx.close();
  }
}
