/**
 * Test helpers: bring up a per-suite schema in the test database, run
 * migrations against it, expose the Drizzle handle. Each test file gets a
 * fresh schema so it can run in parallel without collisions.
 *
 * Requires DATABASE_URL_TEST (default postgres://trading:trading@localhost:5432/trading_test).
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import { runMigrations } from "./migrate.js";
import * as schema from "./schema/index.js";

const TEST_DATABASE_URL =
  process.env["DATABASE_URL_TEST"] ?? "postgres://trading:trading@localhost:5432/trading_test";

const MIGRATIONS_DIR = resolve(
  fileURLToPath(new URL("../migrations", import.meta.url)),
);

export interface TestDb {
  db: NodePgDatabase<typeof schema>;
  pool: pg.Pool;
  schemaName: string;
  cleanup(): Promise<void>;
}

/** Create an isolated Postgres schema, migrate it, return a Drizzle handle. */
export async function createTestDb(suite: string): Promise<TestDb> {
  const schemaName = `test_${suite}_${Math.floor(Math.random() * 1_000_000)}`.toLowerCase();

  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL,
    max: 4,
    // Each pooled connection enters the suite's schema by default.
    options: `-c search_path=${schemaName},public`,
  });

  // Bootstrap: create the schema. The migration runner will then create
  // its tables inside it (search_path is set per connection above).
  const bootstrap = await pool.connect();
  try {
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  } finally {
    bootstrap.release();
  }

  await runMigrations(pool, MIGRATIONS_DIR);

  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    schemaName,
    async cleanup() {
      const client = await pool.connect();
      try {
        await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      } finally {
        client.release();
      }
      await pool.end();
    },
  };
}
