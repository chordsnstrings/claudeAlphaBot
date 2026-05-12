/** Lightweight DB health check used by HTTP /healthz endpoints. */

import { sql } from "drizzle-orm";

import type { Db } from "./db.js";

export interface HealthResult {
  ok: boolean;
  latencyMs: number;
  postgresVersion: string | null;
  timescaledbInstalled: boolean;
  error?: string;
}

export async function healthCheck(db: Db): Promise<HealthResult> {
  const t0 = Date.now();
  try {
    const r1 = await db.execute<{ version: string }>(sql`SELECT version() AS version`);
    const r2 = await db.execute<{ installed: boolean }>(
      sql`SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='timescaledb') AS installed`,
    );
    const version = r1.rows[0]?.version ?? null;
    const installed = r2.rows[0]?.installed ?? false;
    return {
      ok: true,
      latencyMs: Date.now() - t0,
      postgresVersion: version,
      timescaledbInstalled: installed,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      postgresVersion: null,
      timescaledbInstalled: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
