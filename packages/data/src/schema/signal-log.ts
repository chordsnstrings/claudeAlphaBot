import { check, index, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { session } from "./session.js";
import { trade } from "./trade.js";

export const signalLog = pgTable(
  "signal_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sessionId: uuid("session_id").notNull().references(() => session.id),
    originatingStrategy: text("originating_strategy").notNull(),
    instrument: text("instrument").notNull(),
    direction: text("direction").notNull(),
    proposedEntryPrice: numeric("proposed_entry_price", { precision: 18, scale: 6 }),
    proposedStopPrice: numeric("proposed_stop_price", { precision: 18, scale: 6 }),
    proposedTargetPrice: numeric("proposed_target_price", { precision: 18, scale: 6 }),
    proposedSizeFraction: numeric("proposed_size_fraction", { precision: 5, scale: 4 }),
    urgencyScore: numeric("urgency_score", { precision: 5, scale: 4 }),
    signalType: text("signal_type").notNull(),
    entryReason: text("entry_reason"),
    generatedAtBar: timestamp("generated_at_bar", { withTimezone: true, mode: "date" }).notNull(),
    becameTradeId: uuid("became_trade_id").references(() => trade.id),
    rejectedReason: text("rejected_reason"),
    metadata: jsonb("metadata"),
  },
  (t) => ({
    sessionIdIdx: index("signal_log_session_id_idx").on(t.sessionId),
    generatedAtBarIdx: index("signal_log_generated_at_bar_idx").on(t.generatedAtBar),
    directionChk: check("signal_log_direction_chk", sql`${t.direction} IN ('long','short')`),
  }),
);

export type SignalLogRow = typeof signalLog.$inferSelect;
export type NewSignalLogRow = typeof signalLog.$inferInsert;
