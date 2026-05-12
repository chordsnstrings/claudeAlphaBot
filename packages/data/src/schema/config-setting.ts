import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const configSetting = pgTable("config_setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .default(sql`now()`),
  updatedBy: text("updated_by").notNull(),
  previousValue: jsonb("previous_value"),
});

export type ConfigSettingRow = typeof configSetting.$inferSelect;
export type NewConfigSettingRow = typeof configSetting.$inferInsert;
