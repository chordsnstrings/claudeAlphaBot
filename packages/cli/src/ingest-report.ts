/** ingest:report — row counts + first/last bar per (instrument, timeframe). */

import { logger } from "@trading/core";
import { FULL_DAILY_UNIVERSE, M1_UNIVERSE, reportAll } from "@trading/data";

import { buildContext } from "./context.js";

const log = logger("cli.ingest-report");

export async function runIngestReport(): Promise<number> {
  const ctx = buildContext();
  try {
    const pairs: Array<{ instrument: string; timeframe: "m1" | "d1" }> = [
      ...FULL_DAILY_UNIVERSE.map((i: string) => ({ instrument: i, timeframe: "d1" as const })),
      ...M1_UNIVERSE.map((i: string) => ({ instrument: i, timeframe: "m1" as const })),
    ];
    const report = await reportAll(ctx.db, pairs);

    // Print one structured log row per pair (operator-readable in jq/grep).
    for (const r of report) {
      log.info(
        {
          instrument: r.instrument,
          timeframe: r.timeframe,
          rows: r.rows,
          first: r.firstBar,
          last: r.lastBar,
        },
        "pair",
      );
    }
    const total = report.reduce((acc: number, r) => acc + r.rows, 0);
    log.info({ pairs: report.length, total }, "report total");
    return 0;
  } finally {
    await ctx.close();
  }
}
