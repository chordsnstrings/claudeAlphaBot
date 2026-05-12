import { eq } from "drizzle-orm";

import type { Db } from "../db.js";
import { trade, type NewTradeRow, type TradeRow } from "../schema/trade.js";

export class TradeRepo {
  constructor(private readonly db: Db) {}

  async insert(row: NewTradeRow): Promise<TradeRow> {
    const out = await this.db.insert(trade).values(row).returning();
    const first = out[0];
    if (first === undefined) {
      throw new Error("trade insert returned no rows");
    }
    return first;
  }

  async findBySession(sessionId: string): Promise<TradeRow[]> {
    return this.db.select().from(trade).where(eq(trade.sessionId, sessionId));
  }
}
