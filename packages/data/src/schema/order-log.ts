import { jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { session } from "./session.js";
import { signalLog } from "./signal-log.js";

export const orderLog = pgTable("order_log", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: uuid("session_id").notNull().references(() => session.id),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .default(sql`now()`),
  originatingSignalId: uuid("originating_signal_id").references(() => signalLog.id),
  orderType: text("order_type").notNull(),
  instrument: text("instrument").notNull(),
  direction: text("direction"),
  lotSize: numeric("lot_size", { precision: 10, scale: 4 }),
  price: numeric("price", { precision: 18, scale: 6 }),
  brokerOrderId: text("broker_order_id"),
  status: text("status").notNull(),
  fillPrice: numeric("fill_price", { precision: 18, scale: 6 }),
  fillTime: timestamp("fill_time", { withTimezone: true, mode: "date" }),
  rejectionReason: text("rejection_reason"),
  metadata: jsonb("metadata"),
});

export type OrderLogRow = typeof orderLog.$inferSelect;
export type NewOrderLogRow = typeof orderLog.$inferInsert;
