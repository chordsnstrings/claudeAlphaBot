import { eq } from "drizzle-orm";

import type { Db } from "../db.js";
import { session, type NewSessionRow, type SessionRow } from "../schema/session.js";

export class SessionRepo {
  constructor(private readonly db: Db) {}

  async create(row: NewSessionRow): Promise<SessionRow> {
    const inserted = await this.db.insert(session).values(row).returning();
    const first = inserted[0];
    if (first === undefined) {
      throw new Error("session insert returned no rows");
    }
    return first;
  }

  async findById(id: string): Promise<SessionRow | null> {
    const rows = await this.db.select().from(session).where(eq(session.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async updateStatus(
    id: string,
    status: SessionRow["status"],
    extra: Partial<Pick<SessionRow, "endedAt" | "haltReason" | "errorDetails" | "aggregateMetrics" | "currentEquityUsd" | "tradeCount">> = {},
  ): Promise<void> {
    await this.db.update(session).set({ status, ...extra }).where(eq(session.id, id));
  }
}
