import { and, desc, eq } from "drizzle-orm";

import type { Db } from "../db.js";
import {
  dataValidationIssue,
  type DataValidationIssueRow,
  type NewDataValidationIssueRow,
} from "../schema/data-validation-issue.js";

export class ValidationIssueRepo {
  constructor(private readonly db: Db) {}

  async insert(row: NewDataValidationIssueRow): Promise<DataValidationIssueRow> {
    const out = await this.db.insert(dataValidationIssue).values(row).returning();
    const first = out[0];
    if (first === undefined) {
      throw new Error("data_validation_issue insert returned no rows");
    }
    return first;
  }

  async insertMany(rows: NewDataValidationIssueRow[]): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }
    const out = await this.db.insert(dataValidationIssue).values(rows).returning({
      id: dataValidationIssue.id,
    });
    return out.length;
  }

  async findRecent(
    instrument?: string,
    timeframe?: string,
    limit = 100,
  ): Promise<DataValidationIssueRow[]> {
    const conditions = [];
    if (instrument !== undefined) {
      conditions.push(eq(dataValidationIssue.instrument, instrument));
    }
    if (timeframe !== undefined) {
      conditions.push(eq(dataValidationIssue.timeframe, timeframe));
    }
    const query = this.db.select().from(dataValidationIssue);
    const filtered = conditions.length > 0 ? query.where(and(...conditions)) : query;
    return filtered.orderBy(desc(dataValidationIssue.detectedAt)).limit(limit);
  }
}
