import { eq } from "drizzle-orm";

import type { Db } from "../db.js";
import { orderLog, type NewOrderLogRow, type OrderLogRow } from "../schema/order-log.js";

export class OrderLogRepo {
  constructor(private readonly db: Db) {}

  async insert(row: NewOrderLogRow): Promise<OrderLogRow> {
    const out = await this.db.insert(orderLog).values(row).returning();
    const first = out[0];
    if (first === undefined) {
      throw new Error("order_log insert returned no rows");
    }
    return first;
  }

  async updateStatus(
    id: string,
    status: string,
    extra: Partial<Pick<OrderLogRow, "fillPrice" | "fillTime" | "rejectionReason" | "brokerOrderId">> = {},
  ): Promise<void> {
    await this.db.update(orderLog).set({ status, ...extra }).where(eq(orderLog.id, id));
  }
}
