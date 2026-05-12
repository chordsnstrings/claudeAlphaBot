/** Tiny helper: parse DATABASE_URL, open a pool, wire repos. */

import { buildRepos, createDb, type Db, type Repos } from "@trading/data";
import { logger } from "@trading/core";

export interface CliContext {
  db: Db;
  repos: Repos;
  close(): Promise<void>;
}

export function buildContext(): CliContext {
  const log = logger("cli");
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url.length === 0) {
    log.fatal("DATABASE_URL is not set");
    throw new Error("DATABASE_URL is required");
  }
  const handle = createDb({ databaseUrl: url, poolSize: 4 });
  return {
    db: handle.db,
    repos: buildRepos(handle.db),
    close: () => handle.close(),
  };
}
