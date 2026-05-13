/**
 * Fastify HTTP server — the operational UI for the trading system.
 *
 * Spec §9.20 + §12. Built as server-rendered HTML pages (no JS bundle)
 * with Server-Sent Events for live updates. Replaces cTrader for
 * day-to-day operations.
 *
 * Framework choice: Fastify (already a Node-native HTTP framework, ~5x
 * faster than Express, first-party TypeScript types, small footprint).
 * We deliberately did NOT pick Next.js/Remix/SvelteKit because:
 *   - The full operator surface is ~6 pages of read-mostly tables +
 *     forms; SPA tooling would dwarf the actual feature code.
 *   - The same Node process already runs the engine, so co-locating
 *     the UI inside it avoids the cross-service auth + state sync
 *     burden a front-end SPA would introduce.
 *   - Linear-style aesthetic per spec §12 is achievable with a small
 *     CSS file; shadcn is overkill for the surface area.
 *
 * Routes:
 *   GET  /                  -> redirect to /dashboard or /login
 *   GET  /login             -> login form
 *   POST /login             -> verify creds, set session cookie
 *   POST /logout            -> clear session cookie
 *   GET  /dashboard         -> account + positions + strategies + events
 *   GET  /backtests         -> session list
 *   GET  /backtests/:id     -> session detail (trades + metrics)
 *   GET  /config            -> risk config edit form
 *   POST /api/config        -> hot-reload risk config
 *   GET  /orders            -> manual order form + current positions
 *   POST /api/manual-order  -> submit manual order (risk-checked)
 *   POST /api/close-position -> close one position manually
 *   POST /api/strategy/pause | resume | kill -> RuntimeOps actions
 *   POST /api/emergency-stop -> RuntimeOps.emergencyStop
 *   GET  /events            -> SSE stream (refresh hint every N sec)
 *   GET  /api/health        -> public health JSON
 */

import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  fastify,
} from "fastify";

import {
  type AccountInfo,
  type Position,
  type RiskConfig,
  logger,
} from "@trading/core";
import type { Repos } from "@trading/data";
import { computeHealth } from "@trading/engine";
import type { RuntimeOps } from "@trading/risk";

import {
  type AuthConfig,
  issueSession,
  verifyCredentials,
  verifySession,
} from "./auth.js";
import { escape, layout } from "./views/layout.js";
import {
  backtestDetailPage,
  backtestsPage,
  configPage,
  dashboardPage,
  loginPage,
  manualOrdersPage,
} from "./views/pages.js";

const log = logger("web.server");

const SESSION_COOKIE = "trading_session";

export interface ServerDeps {
  authConfig: AuthConfig;
  repos: Repos;
  runtimeOps: RuntimeOps | null;
  /** Optional live-mode session id whose account/positions are shown. */
  liveSessionId?: string;
  /** Current risk config; the server reads + mutates this in-memory. */
  riskConfig: RiskConfig;
  /** Account info source — null when not yet connected. */
  accountInfo: () => Promise<AccountInfo | null>;
  /** Current open positions across the live system. */
  openPositions: () => Promise<Position[]>;
  /** Process start time for /health uptime. */
  startedAt: Date;
  /** Code version for /health. */
  codeVersion: string;
}

function userFromReq(req: FastifyRequest, auth: AuthConfig): { name: string; role: "admin" | "operator" } | null {
  const token = req.cookies[SESSION_COOKIE];
  const session = verifySession(auth, token);
  if (session === null) {
    return null;
  }
  return { name: session.username, role: "operator" };
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = fastify({ logger: false });
  await app.register(cookie, { secret: deps.authConfig.sessionSecret });
  await app.register(formbody);

  // ------------------------------------------------- public routes

  app.get("/api/health", async () => {
    return computeHealth({
      dbPing: async () => null,
      dataFeed: null,
      execution: null,
      clock: { now: () => new Date(), sleep: async () => undefined },
      codeVersion: deps.codeVersion,
      startedAt: deps.startedAt,
    });
  });

  app.get("/", async (req, reply) => {
    if (userFromReq(req, deps.authConfig) === null) {
      return reply.redirect("/login");
    }
    return reply.redirect("/dashboard");
  });

  app.get("/login", async (_req, reply) => {
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .send(layout({ title: "Sign in", body: loginPage({}), user: null }));
  });

  app.post("/login", async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string };
    const username = String(body.username ?? "");
    const password = String(body.password ?? "");
    if (!verifyCredentials(deps.authConfig, username, password)) {
      return reply
        .code(401)
        .header("content-type", "text/html; charset=utf-8")
        .send(
          layout({
            title: "Sign in",
            body: loginPage({ error: "Invalid username or password." }),
            user: null,
          }),
        );
    }
    const token = issueSession(deps.authConfig, username);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // operator deploys behind TLS terminator (Caddy)
      path: "/",
    });
    log.info({ username }, "login");
    return reply.redirect("/dashboard");
  });

  app.post("/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.redirect("/login");
  });

  // ------------------------------------------------- gated routes

  app.addHook("onRequest", async (req, reply) => {
    if (
      req.url === "/login" ||
      req.url === "/" ||
      req.url === "/api/health" ||
      req.url.startsWith("/static/")
    ) {
      return;
    }
    if (userFromReq(req, deps.authConfig) === null) {
      if (req.method === "GET") {
        return reply.redirect("/login");
      }
      return reply.code(401).send({ error: "not_authenticated" });
    }
  });

  app.get("/dashboard", async (req, reply) => {
    const user = userFromReq(req, deps.authConfig);
    if (user === null) {
      return reply.redirect("/login");
    }
    const account = await deps.accountInfo();
    const positions = await deps.openPositions();
    const events = deps.liveSessionId
      ? await deps.repos.audit.findBySession(deps.liveSessionId, 20)
      : [];
    const strategies = deps.runtimeOps?.states() ?? {};
    const modeBadge =
      account?.accountType === "demo"
        ? "DEMO"
        : account?.accountType === "live"
          ? "LIVE"
          : null;
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .send(
        layout({
          title: "Dashboard",
          user,
          modeBadge,
          body: dashboardPage({ account, positions, strategies, recentEvents: events }),
        }),
      );
  });

  app.get("/backtests", async (req, reply) => {
    const user = userFromReq(req, deps.authConfig);
    if (user === null) {
      return reply.redirect("/login");
    }
    // Use a small raw query via the pool to list recent backtest sessions.
    // (BarRepo + friends don't expose a generic session-list query yet.)
    const rows = await listRecentSessions(deps.repos);
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .send(
        layout({
          title: "Backtests",
          user,
          body: backtestsPage(rows),
        }),
      );
  });

  app.get<{ Params: { id: string } }>("/backtests/:id", async (req, reply) => {
    const user = userFromReq(req, deps.authConfig);
    if (user === null) {
      return reply.redirect("/login");
    }
    const session = await deps.repos.sessions.findById(req.params.id);
    if (session === null) {
      return reply.code(404).send("not found");
    }
    const trades = await deps.repos.trades.findBySession(req.params.id);
    const events = await deps.repos.audit.findBySession(req.params.id, 50);
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .send(
        layout({
          title: `Backtest ${session.id.slice(0, 8)}`,
          user,
          body: backtestDetailPage({ session, trades, events }),
        }),
      );
  });

  app.get("/config", async (req, reply) => {
    const user = userFromReq(req, deps.authConfig);
    if (user === null) {
      return reply.redirect("/login");
    }
    const row = await deps.repos.config.get("risk.config");
    const lastChanged = row?.updatedAt ?? null;
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .send(
        layout({
          title: "Configuration",
          user,
          body: configPage(deps.riskConfig, lastChanged),
        }),
      );
  });

  app.post("/api/config", async (req, reply) => {
    const user = userFromReq(req, deps.authConfig);
    if (user === null) {
      return reply.code(401).send({ error: "not_authenticated" });
    }
    if (deps.runtimeOps === null) {
      return reply.code(503).send({ error: "live_runtime_not_available" });
    }
    const body = req.body as Record<string, string>;
    const next = parseRiskConfig(body);
    await deps.runtimeOps.reloadRiskConfig(user.name, next);
    Object.assign(deps.riskConfig, next);
    return reply.redirect("/config");
  });

  app.get("/orders", async (req, reply) => {
    const user = userFromReq(req, deps.authConfig);
    if (user === null) {
      return reply.redirect("/login");
    }
    const positions = await deps.openPositions();
    const events = deps.liveSessionId
      ? (await deps.repos.audit.findBySession(deps.liveSessionId, 50))
          .filter((e) => e.category === "order" && /manual/.test(e.description))
      : [];
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .send(
        layout({
          title: "Manual orders",
          user,
          body: manualOrdersPage({ positions, recentManualEvents: events }),
        }),
      );
  });

  app.post("/api/manual-order", async (req, reply) => {
    const user = userFromReq(req, deps.authConfig);
    if (user === null || deps.runtimeOps === null) {
      return reply.code(401).send({ error: "not_authenticated_or_offline" });
    }
    const b = req.body as Record<string, string>;
    const direction = b["direction"] === "short" ? "short" : "long";
    const orderType =
      b["orderType"] === "limit" || b["orderType"] === "stop"
        ? b["orderType"]
        : "market";
    const priceRaw = b["price"];
    const result = await deps.runtimeOps.submitManualOrder(user.name, {
      instrument: String(b["instrument"] ?? "").toUpperCase(),
      direction,
      orderType,
      lotSize: Number(b["lotSize"]),
      price: priceRaw === undefined || priceRaw === "" ? null : Number(priceRaw),
      stopPrice: Number(b["stopPrice"]),
      targetPrice: Number(b["targetPrice"]),
      reason: String(b["reason"] ?? "manual"),
    });
    log.info({ user: user.name, result }, "manual order submitted");
    return reply.redirect(
      `/orders?result=${encodeURIComponent(result.status)}`,
    );
  });

  app.post("/api/close-position", async (req, reply) => {
    const user = userFromReq(req, deps.authConfig);
    if (user === null || deps.runtimeOps === null) {
      return reply.code(401).send({ error: "not_authenticated_or_offline" });
    }
    const b = req.body as Record<string, string>;
    const positionId = String(b["positionId"] ?? "");
    if (positionId === "") {
      return reply.code(400).send({ error: "positionId_required" });
    }
    await deps.runtimeOps.closeManualPosition(user.name, positionId);
    return reply.redirect("/dashboard");
  });

  for (const action of ["pause", "resume", "kill"] as const) {
    app.post(`/api/strategy/${action}`, async (req, reply) => {
      const user = userFromReq(req, deps.authConfig);
      if (user === null || deps.runtimeOps === null) {
        return reply.code(401).send({ error: "not_authenticated_or_offline" });
      }
      const b = req.body as Record<string, string>;
      const name = String(b["name"] ?? "");
      const reason = String(b["reason"] ?? action);
      if (name === "") {
        return reply.code(400).send({ error: "name_required" });
      }
      if (action === "pause") {
        await deps.runtimeOps.pauseStrategy(name, user.name, reason);
      } else if (action === "resume") {
        await deps.runtimeOps.resumeStrategy(name, user.name);
      } else {
        await deps.runtimeOps.killStrategy(name, user.name, reason);
      }
      return reply.redirect("/dashboard");
    });
  }

  app.post("/api/emergency-stop", async (req, reply) => {
    const user = userFromReq(req, deps.authConfig);
    if (user === null || deps.runtimeOps === null) {
      return reply.code(401).send({ error: "not_authenticated_or_offline" });
    }
    const report = await deps.runtimeOps.emergencyStop(
      user.name,
      "operator-triggered via UI",
    );
    log.fatal({ user: user.name, report }, "emergency stop via UI");
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .send(
        layout({
          title: "Emergency stop",
          user,
          body: `
        <h1 class="bad">Emergency stop completed</h1>
        <section class="card">
          <p>Halted ${report.strategiesHalted.length} strategies, closed
            ${report.positionsClosed} positions in
            ${report.durationMs}ms${report.withinDeadline ? "" : " (over deadline)"}.</p>
          ${
            report.failures.length === 0
              ? ""
              : `<h2>Failures</h2><pre>${escape(JSON.stringify(report.failures, null, 2))}</pre>`
          }
          <p><a href="/dashboard">Back to dashboard</a></p>
        </section>`,
        }),
      );
  });

  app.get("/events", async (req, reply) => {
    if (userFromReq(req, deps.authConfig) === null) {
      return reply.code(401).send({ error: "not_authenticated" });
    }
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    const tick = (): void => {
      reply.raw.write(`event: refresh\ndata: ${Date.now()}\n\n`);
    };
    const handle = setInterval(tick, 5000);
    req.raw.on("close", () => {
      clearInterval(handle);
    });
    // Keep the promise alive.
    await new Promise<void>((resolve) => {
      req.raw.on("close", resolve);
    });
  });

  return app;
}

async function listRecentSessions(repos: Repos) {
  return repos.sessions.findRecent(50);
}

function parseRiskConfig(body: Record<string, string>): RiskConfig {
  const fields = [
    "riskPerTradePct",
    "maxTotalOpenRiskPct",
    "maxCorrelatedClusterPct",
    "maxMarginUtilizationPct",
    "dailyLossLimitPct",
    "weeklySoftAlertPct",
    "weeklyHardHaltPct",
    "monthlySoftAlertPct",
    "monthlyHardHaltPct",
    "drawdownSoftReducePct",
    "drawdownEmergencyStopPct",
    "drawdownRebuildRequiredPct",
  ] as const;
  const out = {} as RiskConfig;
  for (const f of fields) {
    const v = Number(body[f]);
    if (!Number.isFinite(v)) {
      throw new Error(`invalid value for ${f}: ${body[f]}`);
    }
    out[f] = v;
  }
  return out;
}

export type FastifyServer = FastifyInstance;
export type FastifyRequestType = FastifyRequest;
export type FastifyReplyType = FastifyReply;
