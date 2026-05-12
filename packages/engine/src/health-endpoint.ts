/**
 * Health + metrics HTTP endpoint scaffolding (spec §9.23).
 *
 * Exposes:
 *   GET /health   -> JSON with overall status + DB + adapters
 *   GET /metrics  -> Prometheus-format counters (placeholder for now;
 *                    operator adds real series during Phase 23 rollout)
 *
 * Designed to be mounted by either the operational UI server (Phases
 * 20-21) or the OAuth callback server (Phase 17) — anywhere the process
 * already runs an HTTP listener.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Clock, ExecutionAdapter, MarketDataFeed } from "@trading/core";

export interface HealthCheckArgs {
  /** Optional DB ping; returns null if healthy or an error string if not. */
  dbPing?: () => Promise<string | null>;
  dataFeed: MarketDataFeed | null;
  execution: ExecutionAdapter | null;
  clock: Clock;
  /** Git SHA or build version for visibility. */
  codeVersion: string;
  /** Process start time; reported as uptimeSeconds. */
  startedAt: Date;
}

export interface HealthReport {
  status: "ok" | "degraded" | "down";
  codeVersion: string;
  uptimeSeconds: number;
  now: string;
  components: {
    database: { ok: boolean; error: string | null };
    dataFeed: { ok: boolean };
    execution: { ok: boolean };
  };
}

export async function computeHealth(args: HealthCheckArgs): Promise<HealthReport> {
  let dbError: string | null = null;
  if (args.dbPing !== undefined) {
    try {
      dbError = await args.dbPing();
    } catch (err) {
      dbError = err instanceof Error ? err.message : String(err);
    }
  }
  const dataFeedOk = args.dataFeed?.isConnected() ?? false;
  const execOk = args.execution?.isConnected() ?? false;
  const dbOk = dbError === null;
  const allOk = dbOk && dataFeedOk && execOk;
  const anyDown = !dbOk || (args.dataFeed !== null && !dataFeedOk) || (args.execution !== null && !execOk);
  return {
    status: allOk ? "ok" : anyDown ? "degraded" : "down",
    codeVersion: args.codeVersion,
    uptimeSeconds: Math.floor((args.clock.now().getTime() - args.startedAt.getTime()) / 1000),
    now: args.clock.now().toISOString(),
    components: {
      database: { ok: dbOk, error: dbError },
      dataFeed: { ok: dataFeedOk },
      execution: { ok: execOk },
    },
  };
}

/** Node-http handler for /health. Returns 200 if ok/degraded, 503 if down. */
export function createHealthHandler(args: HealthCheckArgs) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.url !== "/health") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const report = await computeHealth(args);
    res.writeHead(report.status === "down" ? 503 : 200, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify(report));
  };
}
