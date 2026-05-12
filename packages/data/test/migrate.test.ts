import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "./helpers.js";

describe("migrations", () => {
  let tdb: TestDb;

  beforeAll(async () => {
    tdb = await createTestDb("migrate");
  });

  afterAll(async () => {
    await tdb.cleanup();
  });

  it("creates all expected tables", async () => {
    const client = await tdb.pool.connect();
    try {
      const r = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables
         WHERE schemaname = $1
         ORDER BY tablename`,
        [tdb.schemaName],
      );
      const tables = r.rows.map((row) => row.tablename);
      expect(tables).toEqual(
        expect.arrayContaining([
          "account_snapshot",
          "audit_event",
          "bar",
          "config_setting",
          "data_validation_issue",
          "order_log",
          "schema_migration",
          "session",
          "signal_log",
          "trade",
        ]),
      );
    } finally {
      client.release();
    }
  });

  it("is idempotent: re-running applies zero migrations", async () => {
    const { runMigrations } = await import("../src/migrate.js");
    const result = await runMigrations(
      tdb.pool,
      new URL("../migrations", import.meta.url).pathname,
    );
    expect(result.applied).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);
  });
});
