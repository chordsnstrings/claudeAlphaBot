import { check, index, numeric, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** 1-min/1-hour/daily OHLCV bar. TimescaleDB hypertable in prod. */
export const bar = pgTable(
  "bar",
  {
    instrument: text("instrument").notNull(),
    timeframe: text("timeframe").notNull(),
    timestampUtc: timestamp("timestamp_utc", { withTimezone: true, mode: "date" }).notNull(),
    open: numeric("open", { precision: 18, scale: 6 }).notNull(),
    high: numeric("high", { precision: 18, scale: 6 }).notNull(),
    low: numeric("low", { precision: 18, scale: 6 }).notNull(),
    close: numeric("close", { precision: 18, scale: 6 }).notNull(),
    volume: numeric("volume", { precision: 18, scale: 2 }).notNull().default("0"),
    source: text("source").notNull().default("historical"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.instrument, t.timeframe, t.timestampUtc] }),
    instrumentTimeframeIdx: index("bar_instrument_timeframe_idx").on(t.instrument, t.timeframe),
    timestampIdx: index("bar_timestamp_utc_idx").on(t.timestampUtc),
    timeframeChk: check("bar_timeframe_chk", sql`${t.timeframe} IN ('m1','m5','h1','d1')`),
    sourceChk: check("bar_source_chk", sql`${t.source} IN ('historical','live')`),
  }),
);

export type BarRow = typeof bar.$inferSelect;
export type NewBarRow = typeof bar.$inferInsert;
