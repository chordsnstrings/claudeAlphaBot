import { and, asc, between, eq, sql } from "drizzle-orm";

import type { Db } from "../db.js";
import { bar, type BarRow, type NewBarRow } from "../schema/bar.js";

export class BarRepo {
  constructor(private readonly db: Db) {}

  /** Idempotent bulk insert. Existing PKs are silently skipped. */
  async insertMany(rows: NewBarRow[]): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }
    // Drizzle batches into a single multi-row INSERT.
    const result = await this.db
      .insert(bar)
      .values(rows)
      .onConflictDoNothing({ target: [bar.instrument, bar.timeframe, bar.timestampUtc] })
      .returning({ ts: bar.timestampUtc });
    return result.length;
  }

  async findRange(
    instrument: string,
    timeframe: BarRow["timeframe"],
    from: Date,
    to: Date,
  ): Promise<BarRow[]> {
    return this.db
      .select()
      .from(bar)
      .where(
        and(
          eq(bar.instrument, instrument),
          eq(bar.timeframe, timeframe),
          between(bar.timestampUtc, from, to),
        ),
      )
      .orderBy(asc(bar.timestampUtc));
  }

  async countByInstrumentTimeframe(
    instrument: string,
    timeframe: BarRow["timeframe"],
  ): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(bar)
      .where(and(eq(bar.instrument, instrument), eq(bar.timeframe, timeframe)));
    return rows[0]?.n ?? 0;
  }
}
