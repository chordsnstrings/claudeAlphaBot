import { index, integer, numeric, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { session } from "./session.js";

export const accountSnapshot = pgTable(
  "account_snapshot",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sessionId: uuid("session_id").notNull().references(() => session.id),
    capturedAt: timestamp("captured_at", { withTimezone: true, mode: "date" }).notNull(),
    equityUsd: numeric("equity_usd", { precision: 18, scale: 2 }).notNull(),
    balanceUsd: numeric("balance_usd", { precision: 18, scale: 2 }).notNull(),
    marginUsedUsd: numeric("margin_used_usd", { precision: 18, scale: 2 }).notNull(),
    marginFreeUsd: numeric("margin_free_usd", { precision: 18, scale: 2 }).notNull(),
    openPositionsCount: integer("open_positions_count").notNull(),
    totalOpenRiskPct: numeric("total_open_risk_pct", { precision: 6, scale: 3 }).notNull(),
    unrealizedPnlUsd: numeric("unrealized_pnl_usd", { precision: 18, scale: 2 }).notNull(),
    unrealizedPnlPct: numeric("unrealized_pnl_pct", { precision: 6, scale: 3 }).notNull(),
  },
  (t) => ({
    sessionCapturedIdx: index("account_snapshot_session_captured_idx").on(
      t.sessionId,
      t.capturedAt,
    ),
  }),
);

export type AccountSnapshotRow = typeof accountSnapshot.$inferSelect;
export type NewAccountSnapshotRow = typeof accountSnapshot.$inferInsert;
