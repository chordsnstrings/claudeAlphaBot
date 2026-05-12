import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { session } from "./session.js";

export const trade = pgTable(
  "trade",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sessionId: uuid("session_id").notNull().references(() => session.id),
    originatingSignalId: uuid("originating_signal_id").notNull(),
    originatingStrategy: text("originating_strategy").notNull(),
    instrument: text("instrument").notNull(),
    direction: text("direction").notNull(),
    entryPrice: numeric("entry_price", { precision: 18, scale: 6 }).notNull(),
    exitPrice: numeric("exit_price", { precision: 18, scale: 6 }).notNull(),
    entryTime: timestamp("entry_time", { withTimezone: true, mode: "date" }).notNull(),
    exitTime: timestamp("exit_time", { withTimezone: true, mode: "date" }).notNull(),
    exitReason: text("exit_reason").notNull(),
    lotSize: numeric("lot_size", { precision: 10, scale: 4 }).notNull(),
    notionalUsd: numeric("notional_usd", { precision: 18, scale: 2 }).notNull(),
    initialRiskPct: numeric("initial_risk_pct", { precision: 10, scale: 4 }).notNull(),
    realizedPnlPct: numeric("realized_pnl_pct", { precision: 10, scale: 4 }).notNull(),
    realizedRMultiple: numeric("realized_r_multiple", { precision: 10, scale: 4 }).notNull(),
    initialRiskUsd: numeric("initial_risk_usd", { precision: 18, scale: 2 }).notNull(),
    realizedPnlUsd: numeric("realized_pnl_usd", { precision: 18, scale: 2 }).notNull(),
    initialStopPrice: numeric("initial_stop_price", { precision: 18, scale: 6 }).notNull(),
    initialTargetPrice: numeric("initial_target_price", { precision: 18, scale: 6 }).notNull(),
    totalFrictionUsd: jsonb("total_friction_usd").notNull(),
    holdDurationMinutes: integer("hold_duration_minutes").notNull(),
    metadata: jsonb("metadata").notNull(),
  },
  (t) => ({
    sessionIdIdx: index("trade_session_id_idx").on(t.sessionId),
    entryTimeIdx: index("trade_entry_time_idx").on(t.entryTime),
    directionChk: check("trade_direction_chk", sql`${t.direction} IN ('long','short')`),
  }),
);

export type TradeRow = typeof trade.$inferSelect;
export type NewTradeRow = typeof trade.$inferInsert;
