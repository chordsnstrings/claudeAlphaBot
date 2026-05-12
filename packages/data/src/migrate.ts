/**
 * Hand-rolled migration runner.
 *
 * Why not drizzle-kit migrate? We need raw SQL for TimescaleDB-specific
 * operations (CREATE EXTENSION, create_hypertable) that drizzle-kit cannot
 * emit. Migrations are plain .sql files under `migrations/`, applied in
 * lexicographic order, tracked in `schema_migration`. Each file is run
 * inside a single transaction.
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "@trading/core";
import type pg from "pg";

const log = logger("data.migrate");

const SCHEMA_MIGRATION_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migration (
    name        text         PRIMARY KEY,
    sha256      text         NOT NULL,
    applied_at  timestamptz  NOT NULL DEFAULT now()
  );
`;

export interface MigrationFile {
  name: string;
  sql: string;
  sha256: string;
}

/** Default location of bundled migration files. */
export function defaultMigrationsDir(): string {
  // dist/migrate.js sits next to dist/; migrations/ is two levels up.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "migrations");
}

export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files = entries.filter((f) => f.endsWith(".sql")).sort();
  const out: MigrationFile[] = [];
  for (const name of files) {
    const sql = await readFile(join(dir, name), "utf8");
    const sha256 = createHash("sha256").update(sql).digest("hex");
    out.push({ name, sql, sha256 });
  }
  return out;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
  total: number;
}

export async function runMigrations(
  pool: pg.Pool,
  migrationsDir: string = defaultMigrationsDir(),
): Promise<MigrateResult> {
  const migrations = await loadMigrations(migrationsDir);
  log.info({ count: migrations.length, dir: migrationsDir }, "loaded migrations");

  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query(SCHEMA_MIGRATION_DDL);
    const existing = await client.query<{ name: string; sha256: string }>(
      "SELECT name, sha256 FROM schema_migration",
    );
    const existingByName = new Map(existing.rows.map((r) => [r.name, r.sha256]));

    for (const m of migrations) {
      const prevSha = existingByName.get(m.name);
      if (prevSha !== undefined) {
        if (prevSha !== m.sha256) {
          throw new Error(
            `Migration ${m.name} was previously applied with a different ` +
              `checksum (db=${prevSha} vs file=${m.sha256}). Refusing to ` +
              "re-apply silently. Add a new migration instead of editing in place.",
          );
        }
        skipped.push(m.name);
        continue;
      }

      log.info({ migration: m.name }, "applying migration");
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query(
          "INSERT INTO schema_migration (name, sha256) VALUES ($1, $2)",
          [m.name, m.sha256],
        );
        await client.query("COMMIT");
        applied.push(m.name);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(
          `Migration ${m.name} failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err instanceof Error ? err : undefined },
        );
      }
    }
  } finally {
    client.release();
  }

  log.info({ applied: applied.length, skipped: skipped.length }, "migrations complete");
  return { applied, skipped, total: migrations.length };
}
