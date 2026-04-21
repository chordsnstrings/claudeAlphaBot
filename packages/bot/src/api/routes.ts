/**
 * Internal command + status REST API — spec Phase 14.
 *
 * All endpoints are unauthenticated; the deployment topology puts the
 * bot behind a private network (docker-compose / DO private networking)
 * and the UI is the only caller. If this ever needs to be exposed,
 * add a bearer-token middleware in front of `registerApiRoutes` — the
 * routes themselves stay auth-agnostic.
 *
 * Every command is written to `command_log` with one of:
 *   OK | ERROR | RATE_LIMITED | REJECTED
 * Rate-limit = 1 request per 10 seconds per endpoint, per remote IP.
 *
 * Endpoints:
 *   POST /api/commands/pause                — flip runtime mode to backtest
 *   POST /api/commands/resume               — restore previous mode
 *   POST /api/commands/force-revalidate     — enqueue FORCED revalidation job
 *   POST /api/commands/close-all-positions  — emergency close (requires confirm token)
 *   POST /api/commands/approve-artifact     — approve a pending artifact swap
 *   GET  /api/status                        — mode, artifact, positions, uptime, last check
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { Pool } from "pg";
import type { Logger } from "pino";

import type { BotMode } from "@hydra/shared";

export interface BotRuntime {
  /** Current effective bot mode. Reading is cheap, writing is via setMode. */
  getMode(): BotMode;
  setMode(mode: BotMode, reason: string): Promise<void>;
  /** Last-known non-backtest mode, for resume-after-pause. */
  getPreviousMode(): BotMode | null;
}

export interface ApiContext {
  readonly pool: Pool;
  readonly logger: Logger;
  readonly runtime: BotRuntime;
  readonly bootTimeMs: number;
  /** Enqueue a FORCED re-validation (scheduler.runNow + audit row). */
  readonly forceRevalidate: (requester: string) => Promise<void>;
  /** Market-close every open position with MANUAL reason. */
  readonly closeAllPositions: (requester: string) => Promise<number>;
  /** Approve a pending artifact (flips deploymentAllowed in DB). */
  readonly approveArtifact: (artifactHash: string, requester: string) => Promise<boolean>;
  /** Describe current artifact for /api/status. */
  readonly artifactInfo: () => {
    readonly path: string | null;
    readonly codeHash: string | null;
    readonly createdAt: string | null;
    readonly deploymentAllowed: boolean;
  } | null;
  /** Count of open_positions rows; used by /api/status. */
  readonly openPositionCount: () => Promise<number>;
  /** Timestamp + outcome of last regime_check_log row; nullable if none. */
  readonly lastRegimeCheck: () => Promise<{
    readonly timestampUtc: number;
    readonly outcome: string;
  } | null>;
}

const CONFIRM_TOKEN = "CONFIRM_CLOSE_ALL";

export async function registerApiRoutes(
  app: FastifyInstance,
  ctx: ApiContext,
): Promise<void> {
  // Rate-limit plugin is per-route when attached via `config.rateLimit`.
  // We register the plugin once with a permissive default, then apply
  // a strict 1-per-10s policy on each command route individually.
  await app.register(rateLimit, {
    global: false,
    max: 1_000, // generous global cap so GETs aren't blocked
    timeWindow: "1 minute",
  });

  const commandLimit = { max: 1, timeWindow: "10 seconds" };

  app.post(
    "/api/commands/pause",
    { config: { rateLimit: commandLimit } },
    async (req, reply) => handlePause(ctx, req, reply),
  );

  app.post(
    "/api/commands/resume",
    { config: { rateLimit: commandLimit } },
    async (req, reply) => handleResume(ctx, req, reply),
  );

  app.post(
    "/api/commands/force-revalidate",
    { config: { rateLimit: commandLimit } },
    async (req, reply) => handleForceRevalidate(ctx, req, reply),
  );

  app.post(
    "/api/commands/close-all-positions",
    { config: { rateLimit: commandLimit } },
    async (req, reply) => handleCloseAllPositions(ctx, req, reply),
  );

  app.post(
    "/api/commands/approve-artifact",
    { config: { rateLimit: commandLimit } },
    async (req, reply) => handleApproveArtifact(ctx, req, reply),
  );

  app.get("/api/status", async () => handleStatus(ctx));

  // Convert rate-limit rejections into our RATE_LIMITED audit rows.
  app.setErrorHandler(async (err, req, reply) => {
    // Fastify's rate-limit plugin sets statusCode=429 on its error.
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 429) {
      await logCommand(ctx, {
        command: commandFromUrl(req.url) ?? "UNKNOWN",
        requester: requesterOf(req),
        payload: null,
        result: "RATE_LIMITED",
        errorMessage: err.message,
      });
      reply.code(429).send({ error: "rate_limited", retry_after_s: 10 });
      return;
    }
    ctx.logger.error({ err }, "api unhandled error");
    reply.code(500).send({ error: "internal_error" });
  });
}

async function handlePause(
  ctx: ApiContext,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const requester = requesterOf(req);
  try {
    const prev = ctx.runtime.getMode();
    if (prev === "backtest") {
      await logCommand(ctx, {
        command: "PAUSE",
        requester,
        payload: null,
        result: "REJECTED",
        errorMessage: "already paused (mode=backtest)",
      });
      reply.code(409).send({ error: "already_paused", mode: prev });
      return;
    }
    await ctx.runtime.setMode("backtest", "operator pause");
    await logCommand(ctx, {
      command: "PAUSE",
      requester,
      payload: { previousMode: prev },
      result: "OK",
    });
    reply.send({ ok: true, mode: "backtest", previousMode: prev });
  } catch (err) {
    await logCommand(ctx, {
      command: "PAUSE",
      requester,
      payload: null,
      result: "ERROR",
      errorMessage: errorMessage(err),
    });
    reply.code(500).send({ error: errorMessage(err) });
  }
}

async function handleResume(
  ctx: ApiContext,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const requester = requesterOf(req);
  try {
    const current = ctx.runtime.getMode();
    const previous = ctx.runtime.getPreviousMode();
    if (current !== "backtest") {
      await logCommand(ctx, {
        command: "RESUME",
        requester,
        payload: null,
        result: "REJECTED",
        errorMessage: `not paused (mode=${current})`,
      });
      reply.code(409).send({ error: "not_paused", mode: current });
      return;
    }
    if (!previous || previous === "backtest") {
      await logCommand(ctx, {
        command: "RESUME",
        requester,
        payload: null,
        result: "REJECTED",
        errorMessage: "no previous non-backtest mode to restore",
      });
      reply.code(409).send({ error: "no_previous_mode" });
      return;
    }
    await ctx.runtime.setMode(previous, "operator resume");
    await logCommand(ctx, {
      command: "RESUME",
      requester,
      payload: { restored: previous },
      result: "OK",
    });
    reply.send({ ok: true, mode: previous });
  } catch (err) {
    await logCommand(ctx, {
      command: "RESUME",
      requester,
      payload: null,
      result: "ERROR",
      errorMessage: errorMessage(err),
    });
    reply.code(500).send({ error: errorMessage(err) });
  }
}

async function handleForceRevalidate(
  ctx: ApiContext,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const requester = requesterOf(req);
  try {
    await ctx.forceRevalidate(requester);
    await logCommand(ctx, {
      command: "FORCE_REVALIDATE",
      requester,
      payload: null,
      result: "OK",
    });
    reply.send({ ok: true, enqueued: true });
  } catch (err) {
    await logCommand(ctx, {
      command: "FORCE_REVALIDATE",
      requester,
      payload: null,
      result: "ERROR",
      errorMessage: errorMessage(err),
    });
    reply.code(500).send({ error: errorMessage(err) });
  }
}

async function handleCloseAllPositions(
  ctx: ApiContext,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const requester = requesterOf(req);
  const body = (req.body ?? {}) as { confirm?: unknown };
  if (body.confirm !== CONFIRM_TOKEN) {
    await logCommand(ctx, {
      command: "CLOSE_ALL_POSITIONS",
      requester,
      payload: { confirm: typeof body.confirm === "string" ? body.confirm : null },
      result: "REJECTED",
      errorMessage: `missing or wrong confirm token (expected "${CONFIRM_TOKEN}")`,
    });
    reply.code(400).send({
      error: "confirm_required",
      hint: `POST body must be {"confirm":"${CONFIRM_TOKEN}"}`,
    });
    return;
  }
  try {
    const closed = await ctx.closeAllPositions(requester);
    await logCommand(ctx, {
      command: "CLOSE_ALL_POSITIONS",
      requester,
      payload: { closed },
      result: "OK",
    });
    reply.send({ ok: true, closed });
  } catch (err) {
    await logCommand(ctx, {
      command: "CLOSE_ALL_POSITIONS",
      requester,
      payload: null,
      result: "ERROR",
      errorMessage: errorMessage(err),
    });
    reply.code(500).send({ error: errorMessage(err) });
  }
}

async function handleApproveArtifact(
  ctx: ApiContext,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const requester = requesterOf(req);
  const body = (req.body ?? {}) as { artifactHash?: unknown };
  const hash = typeof body.artifactHash === "string" ? body.artifactHash : null;
  if (!hash) {
    await logCommand(ctx, {
      command: "APPROVE_ARTIFACT",
      requester,
      payload: body as Record<string, unknown>,
      result: "REJECTED",
      errorMessage: "missing artifactHash",
    });
    reply.code(400).send({ error: "artifactHash_required" });
    return;
  }
  try {
    const approved = await ctx.approveArtifact(hash, requester);
    if (!approved) {
      await logCommand(ctx, {
        command: "APPROVE_ARTIFACT",
        requester,
        payload: { artifactHash: hash },
        result: "REJECTED",
        errorMessage: "no such pending artifact",
      });
      reply.code(404).send({ error: "artifact_not_found", artifactHash: hash });
      return;
    }
    await logCommand(ctx, {
      command: "APPROVE_ARTIFACT",
      requester,
      payload: { artifactHash: hash },
      result: "OK",
    });
    reply.send({ ok: true, artifactHash: hash });
  } catch (err) {
    await logCommand(ctx, {
      command: "APPROVE_ARTIFACT",
      requester,
      payload: { artifactHash: hash },
      result: "ERROR",
      errorMessage: errorMessage(err),
    });
    reply.code(500).send({ error: errorMessage(err) });
  }
}

async function handleStatus(ctx: ApiContext): Promise<Record<string, unknown>> {
  const [openPositions, lastCheck] = await Promise.all([
    ctx.openPositionCount(),
    ctx.lastRegimeCheck(),
  ]);
  return {
    mode: ctx.runtime.getMode(),
    previousMode: ctx.runtime.getPreviousMode(),
    artifact: ctx.artifactInfo(),
    openPositions,
    uptimeMs: Date.now() - ctx.bootTimeMs,
    lastRegimeCheck: lastCheck,
    timestamp: new Date().toISOString(),
  };
}

function requesterOf(req: FastifyRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0]!.trim();
  return req.ip ?? "unknown";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function commandFromUrl(url: string): string | null {
  if (url.startsWith("/api/commands/pause")) return "PAUSE";
  if (url.startsWith("/api/commands/resume")) return "RESUME";
  if (url.startsWith("/api/commands/force-revalidate")) return "FORCE_REVALIDATE";
  if (url.startsWith("/api/commands/close-all-positions")) return "CLOSE_ALL_POSITIONS";
  if (url.startsWith("/api/commands/approve-artifact")) return "APPROVE_ARTIFACT";
  return null;
}

interface CommandLogEntry {
  readonly command: string;
  readonly requester: string;
  readonly payload: Record<string, unknown> | null;
  readonly result: "OK" | "ERROR" | "RATE_LIMITED" | "REJECTED";
  readonly errorMessage?: string;
}

async function logCommand(ctx: ApiContext, entry: CommandLogEntry): Promise<void> {
  try {
    await ctx.pool.query(
      `INSERT INTO command_log (timestamp_utc, command, requester, payload, result, error_message)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        Date.now(),
        entry.command,
        entry.requester,
        entry.payload === null ? null : JSON.stringify(entry.payload),
        entry.result,
        entry.errorMessage ?? null,
      ],
    );
  } catch (err) {
    ctx.logger.error({ err, entry }, "failed to write command_log row");
  }
}
