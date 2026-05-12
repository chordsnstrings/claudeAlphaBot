#!/usr/bin/env -S node --enable-source-maps
/**
 * CLI: pnpm --filter @trading/data migrate
 *
 * Reads DATABASE_URL from the environment, opens a pool, runs every pending
 * migration in `packages/data/migrations`, prints a summary, exits cleanly.
 */

import { resolve } from "node:path";

import { logger } from "@trading/core";
import pg from "pg";

import { defaultMigrationsDir, runMigrations } from "./migrate.js";

const log = logger("data.migrate-cli");

const dbUrl = process.env["DATABASE_URL"];
if (dbUrl === undefined || dbUrl.length === 0) {
  log.fatal("DATABASE_URL is not set");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });

// When invoked as `tsx src/migrate-cli.ts` the bundled migrations directory
// is at ../migrations relative to the source file (not dist/).
const sourceMigrationsDir = resolve(import.meta.url.startsWith("file://")
  ? new URL("../migrations", import.meta.url).pathname
  : defaultMigrationsDir());

try {
  const result = await runMigrations(pool, sourceMigrationsDir);
  log.info(
    {
      applied: result.applied,
      skipped_count: result.skipped.length,
      total: result.total,
    },
    "migrate complete",
  );
} catch (err) {
  log.fatal({ err: err instanceof Error ? err.stack : String(err) }, "migrate failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
