/**
 * Hand-rolled migrator that runs SQL files from the repo root's
 * /migrations directory. Each file's name becomes its ID. Already-
 * applied migrations (recorded in schema_migrations) are skipped.
 *
 * Kept intentionally small — we do not need branching, down-migrations,
 * or locking for this project's cadence. All SQL files must be
 * internally idempotent (every object uses IF NOT EXISTS).
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getPool } from "./pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface MigrationFile {
  readonly id: string;
  readonly path: string;
  readonly sql: string;
}

export function migrationsDir(): string {
  // packages/bot/src/db/migrator.ts  →  ../../../migrations
  // packages/bot/dist/db/migrator.js →  ../../../migrations
  return join(__dirname, "..", "..", "..", "..", "migrations");
}

export async function loadMigrations(dir = migrationsDir()): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files = entries.filter((f) => f.endsWith(".sql")).sort();
  const loaded: MigrationFile[] = [];
  for (const name of files) {
    const path = join(dir, name);
    const sql = await readFile(path, "utf8");
    loaded.push({ id: name.replace(/\.sql$/, ""), path, sql });
  }
  return loaded;
}

export async function ensureMigrationsTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at_utc BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::BIGINT
    )
  `);
}

export async function appliedMigrationIds(): Promise<Set<string>> {
  const pool = getPool();
  const result = await pool.query<{ id: string }>("SELECT id FROM schema_migrations");
  return new Set(result.rows.map((r) => r.id));
}

export interface MigrationResult {
  readonly applied: string[];
  readonly skipped: string[];
}

export async function runMigrations(dir?: string): Promise<MigrationResult> {
  await ensureMigrationsTable();
  const migrations = await loadMigrations(dir);
  const applied = await appliedMigrationIds();
  const pool = getPool();
  const appliedNow: string[] = [];
  const skipped: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.id)) {
      skipped.push(m.id);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(m.sql);
      // The migration SQL also INSERTs into schema_migrations,
      // but if it doesn't we still record it here for safety.
      await client.query(
        "INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
        [m.id],
      );
      await client.query("COMMIT");
      appliedNow.push(m.id);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${m.id} failed: ${String(err)}`);
    } finally {
      client.release();
    }
  }
  return { applied: appliedNow, skipped };
}
