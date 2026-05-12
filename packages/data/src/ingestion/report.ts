/**
 * Post-ingestion summary report. For each (instrument, timeframe) pair in
 * the asset universe, query the DB for row count + first/last bar.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";

import type { Db } from "../db.js";
import { bar } from "../schema/bar.js";

export interface IngestReportRow {
  instrument: string;
  timeframe: "m1" | "m5" | "h1" | "d1";
  rows: number;
  firstBar: Date | null;
  lastBar: Date | null;
}

export async function reportForPair(
  db: Db,
  instrument: string,
  timeframe: IngestReportRow["timeframe"],
): Promise<IngestReportRow> {
  const where = and(eq(bar.instrument, instrument), eq(bar.timeframe, timeframe));

  const countRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bar)
    .where(where);
  const n = countRows[0]?.n ?? 0;

  if (n === 0) {
    return { instrument, timeframe, rows: 0, firstBar: null, lastBar: null };
  }

  const firstRow = await db
    .select({ t: bar.timestampUtc })
    .from(bar)
    .where(where)
    .orderBy(asc(bar.timestampUtc))
    .limit(1);
  const lastRow = await db
    .select({ t: bar.timestampUtc })
    .from(bar)
    .where(where)
    .orderBy(desc(bar.timestampUtc))
    .limit(1);

  return {
    instrument,
    timeframe,
    rows: n,
    firstBar: firstRow[0]?.t ?? null,
    lastBar: lastRow[0]?.t ?? null,
  };
}

export async function reportAll(
  db: Db,
  pairs: ReadonlyArray<{ instrument: string; timeframe: IngestReportRow["timeframe"] }>,
): Promise<IngestReportRow[]> {
  const out: IngestReportRow[] = [];
  for (const p of pairs) {
    out.push(await reportForPair(db, p.instrument, p.timeframe));
  }
  return out;
}
