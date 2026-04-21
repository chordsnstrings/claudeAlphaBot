import Fastify, { type FastifyInstance } from "fastify";

import type { Logger } from "pino";

import { healthcheck as dbHealthcheck } from "../db/pool.js";

export interface HealthServerOptions {
  readonly port: number;
  readonly host?: string;
  readonly logger: Logger;
  readonly mode: string;
  readonly artifactInfo: () => {
    readonly path: string | null;
    readonly codeHash: string | null;
    readonly createdAt: string | null;
    readonly deploymentAllowed: boolean;
  } | null;
  readonly bootTimeMs: number;
}

/**
 * Fastify instance hosting /health, /ready.
 * /health is always 200 as long as the process is alive.
 * /ready is only 200 once DB + (if paper/live) artifact are verified.
 *
 * The internal-command API (Phase 14) is added onto this same instance,
 * not a second one.
 */
export async function buildHealthServer(opts: HealthServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // we use pino directly
    trustProxy: true,
  });

  app.get("/health", async () => {
    return {
      status: "ok",
      mode: opts.mode,
      uptime_ms: Date.now() - opts.bootTimeMs,
      timestamp: new Date().toISOString(),
    };
  });

  app.get("/ready", async (_req, reply) => {
    const db = await dbHealthcheck();
    const artifact = opts.artifactInfo();
    const ready = db.ok && (opts.mode === "backtest" || artifact?.deploymentAllowed === true);
    if (!ready) {
      reply.code(503);
    }
    return {
      ready,
      mode: opts.mode,
      db,
      artifact,
      timestamp: new Date().toISOString(),
    };
  });

  return app;
}

export async function startHealthServer(opts: HealthServerOptions): Promise<FastifyInstance> {
  const app = await buildHealthServer(opts);
  await app.listen({ port: opts.port, host: opts.host ?? "0.0.0.0" });
  opts.logger.info({ port: opts.port }, "health server listening");
  return app;
}
