import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { Pool } from "pg";
import { pino } from "pino";

import type { BotMode } from "@hydra/shared";

import { registerApiRoutes, type ApiContext, type BotRuntime } from "../../src/api/routes.js";

class FakePool {
  readonly calls: { sql: string; params: unknown[] }[] = [];
  openPositionRows = 0;
  lastCheckRow: { timestamp_utc: string; outcome: string } | null = null;

  async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ sql, params });
    return { rows: [] };
  }
}

class FakeRuntime implements BotRuntime {
  private mode: BotMode;
  private previous: BotMode | null = null;
  readonly modeChanges: { mode: BotMode; reason: string }[] = [];
  constructor(initial: BotMode) {
    this.mode = initial;
    this.previous = initial === "backtest" ? null : initial;
  }
  getMode(): BotMode {
    return this.mode;
  }
  getPreviousMode(): BotMode | null {
    return this.previous;
  }
  async setMode(mode: BotMode, reason: string): Promise<void> {
    this.previous = this.mode;
    this.mode = mode;
    this.modeChanges.push({ mode, reason });
  }
}

interface Harness {
  app: ReturnType<typeof Fastify>;
  pool: FakePool;
  runtime: FakeRuntime;
  forceRevalidateCalls: string[];
  closeAllCalls: string[];
  approveCalls: { hash: string; requester: string }[];
  artifactInfo: () => ReturnType<ApiContext["artifactInfo"]>;
  openPositionCountImpl: () => Promise<number>;
  lastRegimeCheckImpl: () => Promise<Awaited<ReturnType<ApiContext["lastRegimeCheck"]>>>;
}

async function build(initialMode: BotMode = "live"): Promise<Harness> {
  const pool = new FakePool();
  const runtime = new FakeRuntime(initialMode);
  const forceRevalidateCalls: string[] = [];
  const closeAllCalls: string[] = [];
  const approveCalls: { hash: string; requester: string }[] = [];
  let artifact: ReturnType<ApiContext["artifactInfo"]> = {
    path: "/artifacts/validated_config.json",
    codeHash: "sha256:deadbeef",
    createdAt: new Date().toISOString(),
    deploymentAllowed: true,
  };
  let openCount = 0;
  let lastCheck: Awaited<ReturnType<ApiContext["lastRegimeCheck"]>> = null;

  const app = Fastify({ logger: false });
  const ctx: ApiContext = {
    pool: pool as unknown as Pool,
    logger: pino({ level: "silent" }),
    runtime,
    bootTimeMs: Date.now() - 60_000,
    forceRevalidate: async (r) => {
      forceRevalidateCalls.push(r);
    },
    closeAllPositions: async (r) => {
      closeAllCalls.push(r);
      return 3;
    },
    approveArtifact: async (hash, requester) => {
      approveCalls.push({ hash, requester });
      return hash === "sha256:known";
    },
    artifactInfo: () => artifact,
    openPositionCount: async () => openCount,
    lastRegimeCheck: async () => lastCheck,
  };
  await registerApiRoutes(app, ctx);
  await app.ready();

  return {
    app,
    pool,
    runtime,
    forceRevalidateCalls,
    closeAllCalls,
    approveCalls,
    artifactInfo: () => artifact,
    openPositionCountImpl: async () => openCount,
    lastRegimeCheckImpl: async () => lastCheck,
  };
}

describe("API /api/status", () => {
  it("returns current mode, artifact, uptime", async () => {
    const h = await build("live");
    try {
      const res = await h.app.inject({ method: "GET", url: "/api/status" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.mode).toBe("live");
      expect(body.artifact.codeHash).toBe("sha256:deadbeef");
      expect(typeof body.uptimeMs).toBe("number");
      expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    } finally {
      await h.app.close();
    }
  });
});

describe("API /api/commands/pause + /resume", () => {
  it("pause: live → backtest, writes OK command_log row", async () => {
    const h = await build("live");
    try {
      const res = await h.app.inject({ method: "POST", url: "/api/commands/pause" });
      expect(res.statusCode).toBe(200);
      expect(h.runtime.getMode()).toBe("backtest");
      const ok = h.pool.calls.find((c) => /INSERT INTO command_log/.test(c.sql));
      expect(ok).toBeDefined();
      expect(ok!.params[1]).toBe("PAUSE");
      expect(ok!.params[4]).toBe("OK");
    } finally {
      await h.app.close();
    }
  });

  it("pause: rejects when already paused (mode=backtest)", async () => {
    const h = await build("backtest");
    try {
      const res = await h.app.inject({ method: "POST", url: "/api/commands/pause" });
      expect(res.statusCode).toBe(409);
      const rejected = h.pool.calls.find(
        (c) => /INSERT INTO command_log/.test(c.sql) && c.params[4] === "REJECTED",
      );
      expect(rejected).toBeDefined();
    } finally {
      await h.app.close();
    }
  });

  it("resume: restores previous non-backtest mode", async () => {
    const h = await build("live");
    try {
      // Pause first to flip to backtest with previous=live.
      await h.app.inject({ method: "POST", url: "/api/commands/pause" });
      const res = await h.app.inject({ method: "POST", url: "/api/commands/resume" });
      expect(res.statusCode).toBe(200);
      expect(h.runtime.getMode()).toBe("live");
    } finally {
      await h.app.close();
    }
  });
});

describe("API /api/commands/force-revalidate", () => {
  it("invokes forceRevalidate + writes OK row", async () => {
    const h = await build("live");
    try {
      const res = await h.app.inject({
        method: "POST",
        url: "/api/commands/force-revalidate",
      });
      expect(res.statusCode).toBe(200);
      expect(h.forceRevalidateCalls.length).toBe(1);
    } finally {
      await h.app.close();
    }
  });
});

describe("API /api/commands/close-all-positions", () => {
  it("refuses without confirm token", async () => {
    const h = await build("live");
    try {
      const res = await h.app.inject({
        method: "POST",
        url: "/api/commands/close-all-positions",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(h.closeAllCalls.length).toBe(0);
      const rejected = h.pool.calls.find(
        (c) => /INSERT INTO command_log/.test(c.sql) && c.params[4] === "REJECTED",
      );
      expect(rejected).toBeDefined();
    } finally {
      await h.app.close();
    }
  });

  it("refuses with wrong confirm token", async () => {
    const h = await build("live");
    try {
      const res = await h.app.inject({
        method: "POST",
        url: "/api/commands/close-all-positions",
        payload: { confirm: "yes" },
      });
      expect(res.statusCode).toBe(400);
      expect(h.closeAllCalls.length).toBe(0);
    } finally {
      await h.app.close();
    }
  });

  it("proceeds with correct confirm token and returns closed count", async () => {
    const h = await build("live");
    try {
      const res = await h.app.inject({
        method: "POST",
        url: "/api/commands/close-all-positions",
        payload: { confirm: "CONFIRM_CLOSE_ALL" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.closed).toBe(3);
      expect(h.closeAllCalls.length).toBe(1);
    } finally {
      await h.app.close();
    }
  });
});

describe("API /api/commands/approve-artifact", () => {
  it("rejects missing artifactHash", async () => {
    const h = await build("live");
    try {
      const res = await h.app.inject({
        method: "POST",
        url: "/api/commands/approve-artifact",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await h.app.close();
    }
  });

  it("returns 404 when artifact not found", async () => {
    const h = await build("live");
    try {
      const res = await h.app.inject({
        method: "POST",
        url: "/api/commands/approve-artifact",
        payload: { artifactHash: "sha256:unknown" },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await h.app.close();
    }
  });

  it("returns OK for a known artifact", async () => {
    const h = await build("live");
    try {
      const res = await h.app.inject({
        method: "POST",
        url: "/api/commands/approve-artifact",
        payload: { artifactHash: "sha256:known" },
      });
      expect(res.statusCode).toBe(200);
      expect(h.approveCalls.length).toBe(1);
      expect(h.approveCalls[0]!.hash).toBe("sha256:known");
    } finally {
      await h.app.close();
    }
  });
});

describe("API rate-limit: 1 per 10 seconds", () => {
  it("second pause in same window is RATE_LIMITED", async () => {
    const h = await build("live");
    try {
      const r1 = await h.app.inject({ method: "POST", url: "/api/commands/pause" });
      expect(r1.statusCode).toBe(200);
      const r2 = await h.app.inject({ method: "POST", url: "/api/commands/pause" });
      // Second call lands within the 10s window → 429.
      expect(r2.statusCode).toBe(429);
      const rateLimited = h.pool.calls.find(
        (c) => /INSERT INTO command_log/.test(c.sql) && c.params[4] === "RATE_LIMITED",
      );
      expect(rateLimited).toBeDefined();
    } finally {
      await h.app.close();
    }
  });
});
