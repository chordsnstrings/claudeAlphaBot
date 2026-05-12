import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const dataValidationIssue = pgTable(
  "data_validation_issue",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    detectedAt: timestamp("detected_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    instrument: text("instrument").notNull(),
    timeframe: text("timeframe").notNull(),
    issueType: text("issue_type").notNull(),
    severity: text("severity").notNull(),
    description: text("description").notNull(),
    affectedTimeRangeStart: timestamp("affected_time_range_start", {
      withTimezone: true,
      mode: "date",
    }),
    affectedTimeRangeEnd: timestamp("affected_time_range_end", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (t) => ({
    instrTfIdx: index("data_validation_issue_instr_tf_idx").on(t.instrument, t.timeframe),
    severityChk: check("dvi_severity_chk", sql`${t.severity} IN ('info','warn','error')`),
  }),
);

export type DataValidationIssueRow = typeof dataValidationIssue.$inferSelect;
export type NewDataValidationIssueRow = typeof dataValidationIssue.$inferInsert;
