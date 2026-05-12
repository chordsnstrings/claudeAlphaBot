import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const session = pgTable(
  "session",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
    mode: text("mode").notNull(),
    sessionType: text("session_type").notNull(),
    parentSessionId: uuid("parent_session_id").references((): AnyPgColumn => session.id),
    codeVersion: text("code_version").notNull(),
    dataIntegrityHash: text("data_integrity_hash"),
    instruments: text("instruments").array().notNull(),
    timeframes: text("timeframes").array().notNull(),
    dateRangeFrom: timestamp("date_range_from", { withTimezone: true, mode: "date" }).notNull(),
    dateRangeTo: timestamp("date_range_to", { withTimezone: true, mode: "date" }).notNull(),
    strategies: jsonb("strategies").notNull(),
    orchestratorMode: text("orchestrator_mode").notNull(),
    frictionConfig: jsonb("friction_config"),
    randomSeed: bigint("random_seed", { mode: "bigint" }).notNull(),
    initialEquityUsd: numeric("initial_equity_usd", { precision: 18, scale: 2 }).notNull(),
    currentEquityUsd: numeric("current_equity_usd", { precision: 18, scale: 2 }).notNull(),
    riskConfig: jsonb("risk_config").notNull(),
    aggregateMetrics: jsonb("aggregate_metrics"),
    tradeCount: integer("trade_count").notNull().default(0),
    status: text("status").notNull().default("pending"),
    haltReason: text("halt_reason"),
    errorDetails: text("error_details"),
    accountType: text("account_type"),
    brokerAccountId: text("broker_account_id"),
  },
  (t) => ({
    createdAtIdx: index("session_created_at_idx").on(t.createdAt),
    modeStatusIdx: index("session_mode_status_idx").on(t.mode, t.status),
    sessionTypeIdx: index("session_session_type_idx").on(t.sessionType),
    modeChk: check("session_mode_chk", sql`${t.mode} IN ('backtest','live')`),
    statusChk: check(
      "session_status_chk",
      sql`${t.status} IN ('pending','running','completed','failed','halted','emergency_stopped')`,
    ),
  }),
);

export type SessionRow = typeof session.$inferSelect;
export type NewSessionRow = typeof session.$inferInsert;
