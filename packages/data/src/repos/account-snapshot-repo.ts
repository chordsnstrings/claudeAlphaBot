import { and, desc, eq, gte, lte } from "drizzle-orm";

import type { Db } from "../db.js";
import {
  accountSnapshot,
  type AccountSnapshotRow,
  type NewAccountSnapshotRow,
} from "../schema/account-snapshot.js";

export class AccountSnapshotRepo {
  constructor(private readonly db: Db) {}

  async insert(row: NewAccountSnapshotRow): Promise<AccountSnapshotRow> {
    const out = await this.db.insert(accountSnapshot).values(row).returning();
    const first = out[0];
    if (first === undefined) {
      throw new Error("account_snapshot insert returned no rows");
    }
    return first;
  }

  async findRange(
    sessionId: string,
    from: Date,
    to: Date,
  ): Promise<AccountSnapshotRow[]> {
    return this.db
      .select()
      .from(accountSnapshot)
      .where(
        and(
          eq(accountSnapshot.sessionId, sessionId),
          gte(accountSnapshot.capturedAt, from),
          lte(accountSnapshot.capturedAt, to),
        ),
      )
      .orderBy(desc(accountSnapshot.capturedAt));
  }
}
