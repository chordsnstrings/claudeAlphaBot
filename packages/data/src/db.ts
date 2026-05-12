/**
 * Postgres connection pool + Drizzle client.
 *
 * One shared pool per process; the engine builds a single client and shares
 * it across repositories. Tests get an isolated pool via `createDb()`.
 */

import { logger } from "@trading/core";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema/index.js";

const { Pool } = pg;

export type DbSchema = typeof schema;
export type Db = NodePgDatabase<DbSchema>;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  databaseUrl: string;
  poolSize?: number;
  /** Statement timeout in ms; defaults to 30 s. */
  statementTimeoutMs?: number;
}

export function createDb(opts: CreateDbOptions): DbHandle {
  const log = logger("data.db");
  const pool = new Pool({
    connectionString: opts.databaseUrl,
    max: opts.poolSize ?? 10,
    statement_timeout: opts.statementTimeoutMs ?? 30_000,
    idleTimeoutMillis: 30_000,
  });

  pool.on("error", (err) => {
    log.error({ err }, "postgres pool emitted an error event");
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    async close() {
      await pool.end();
    },
  };
}
