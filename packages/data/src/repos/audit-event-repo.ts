import { and, desc, eq } from "drizzle-orm";

import type { Db } from "../db.js";
import { auditEvent, type AuditEventRow, type NewAuditEventRow } from "../schema/audit-event.js";

export class AuditEventRepo {
  constructor(private readonly db: Db) {}

  async insert(row: NewAuditEventRow): Promise<AuditEventRow> {
    const out = await this.db.insert(auditEvent).values(row).returning();
    const first = out[0];
    if (first === undefined) {
      throw new Error("audit_event insert returned no rows");
    }
    return first;
  }

  async findBySession(sessionId: string, limit = 200): Promise<AuditEventRow[]> {
    return this.db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.sessionId, sessionId))
      .orderBy(desc(auditEvent.createdAt))
      .limit(limit);
  }

  async acknowledge(id: string, at: Date = new Date()): Promise<void> {
    await this.db
      .update(auditEvent)
      .set({ acknowledgedAt: at })
      .where(and(eq(auditEvent.id, id)));
  }
}
