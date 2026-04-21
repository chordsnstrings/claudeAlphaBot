import pg from "pg";

let poolSingleton: pg.Pool | null = null;

/**
 * Lazy pool: constructed on first call, reused forever.
 * Fails loudly if DATABASE_URL is missing.
 */
export function getPool(): pg.Pool {
  if (poolSingleton) return poolSingleton;
  const url = process.env["DATABASE_URL"];
  if (!url || url.trim() === "") {
    throw new Error("DATABASE_URL is required but not set. Refuse to connect to a default.");
  }
  poolSingleton = new pg.Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  return poolSingleton;
}

export async function closePool(): Promise<void> {
  if (poolSingleton) {
    await poolSingleton.end();
    poolSingleton = null;
  }
}

export async function healthcheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const pool = getPool();
    const result = await pool.query<{ ok: number }>("SELECT 1 AS ok");
    const row = result.rows[0];
    return { ok: row?.ok === 1, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: String(err) };
  }
}
