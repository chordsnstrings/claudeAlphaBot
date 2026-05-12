import { and, eq } from "drizzle-orm";

import type { Db } from "../db.js";
import { signalLog, type NewSignalLogRow, type SignalLogRow } from "../schema/signal-log.js";

export class SignalLogRepo {
  constructor(private readonly db: Db) {}

  async insert(row: NewSignalLogRow): Promise<SignalLogRow> {
    const out = await this.db.insert(signalLog).values(row).returning();
    const first = out[0];
    if (first === undefined) {
      throw new Error("signal_log insert returned no rows");
    }
    return first;
  }

  async findBySession(sessionId: string): Promise<SignalLogRow[]> {
    return this.db.select().from(signalLog).where(eq(signalLog.sessionId, sessionId));
  }

  async markBecameTrade(signalId: string, tradeId: string): Promise<void> {
    await this.db
      .update(signalLog)
      .set({ becameTradeId: tradeId })
      .where(and(eq(signalLog.id, signalId)));
  }

  async markRejected(signalId: string, reason: string): Promise<void> {
    await this.db
      .update(signalLog)
      .set({ rejectedReason: reason })
      .where(eq(signalLog.id, signalId));
  }
}
