import { Pool } from "pg";

/**
 * Shared pg Pool for server components + server actions. The UI reads
 * the same schema the bot writes to (see migrations/). Next.js's module
 * cache gives us a single pool per process, which is what we want.
 *
 * Set DATABASE_URL in the deployment env. In local dev, `.env.local`
 * is auto-loaded by Next.
 */
declare global {
  // eslint-disable-next-line no-var
  var __hydra_pg_pool: Pool | undefined;
}

export function db(): Pool {
  if (!globalThis.__hydra_pg_pool) {
    const url = process.env["DATABASE_URL"];
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set. The UI needs read access to the bot's Postgres to render data.",
      );
    }
    globalThis.__hydra_pg_pool = new Pool({ connectionString: url, max: 5 });
  }
  return globalThis.__hydra_pg_pool;
}
