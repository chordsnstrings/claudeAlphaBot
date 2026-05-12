import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { session } from "./session.js";

export const auditEvent = pgTable(
  "audit_event",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    sessionId: uuid("session_id").references(() => session.id),
    severity: text("severity").notNull(),
    category: text("category").notNull(),
    description: text("description").notNull(),
    metadata: jsonb("metadata"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    sessionCreatedIdx: index("audit_event_session_created_idx").on(t.sessionId, t.createdAt),
    categoryIdx: index("audit_event_category_idx").on(t.category),
    severityIdx: index("audit_event_severity_idx").on(t.severity),
  }),
);

export type AuditEventRow = typeof auditEvent.$inferSelect;
export type NewAuditEventRow = typeof auditEvent.$inferInsert;
