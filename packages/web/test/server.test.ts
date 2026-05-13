/**
 * Operational UI smoke tests. Builds the Fastify server with stub
 * dependencies (no DB needed) and exercises the auth gate + each gated
 * route + the emergency-stop POST.
 */

import { randomBytes } from "node:crypto";

import {
  DEFAULT_RISK_CONFIG,
  type AccountInfo,
  type Position,
} from "@trading/core";
import { describe, expect, it } from "vitest";

import { hashPassword, type AuthConfig } from "../src/auth.js";
import { buildServer, type ServerDeps } from "../src/server.js";

function makeAuth(password: string): AuthConfig {
  const saltHex = randomBytes(16).toString("hex");
  return {
    username: "ops",
    passwordHashHex: hashPassword(password, saltHex),
    passwordSaltHex: saltHex,
    sessionSecret: "test-secret-xyz",
  };
}

/**
 * Build a Repos surface limited to what the UI calls. Cast through
 * unknown -> Repos so TS allows the partial shape.
 */
function stubRepos(): ServerDeps["repos"] {
  return {
    sessions: {
      findById: async () => null,
      findRecent: async () => [],
    },
    trades: { findBySession: async () => [] },
    audit: { findBySession: async () => [] },
    config: { get: async () => null },
  } as unknown as ServerDeps["repos"];
}

async function buildAndAuth(deps: ServerDeps) {
  const app = await buildServer(deps);
  const loginRes = await app.inject({
    method: "POST",
    url: "/login",
    payload: "username=ops&password=hunter2",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const cookieHeader = loginRes.headers["set-cookie"];
  const cookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  return { app, cookie: cookie ?? "" };
}

function baseDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    authConfig: makeAuth("hunter2"),
    repos: stubRepos(),
    runtimeOps: null,
    riskConfig: { ...DEFAULT_RISK_CONFIG },
    accountInfo: async () => null,
    openPositions: async () => [],
    startedAt: new Date("2025-01-01T00:00:00Z"),
    codeVersion: "test",
    ...overrides,
  };
}

describe("auth gate", () => {
  it("/dashboard redirects to /login when not signed in", async () => {
    const app = await buildServer(baseDeps());
    const res = await app.inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad credentials with 401", async () => {
    const app = await buildServer(baseDeps());
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: "username=ops&password=wrong",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain("Invalid username or password");
  });

  it("accepts valid credentials and sets a session cookie", async () => {
    const app = await buildServer(baseDeps());
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: "username=ops&password=hunter2",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/dashboard");
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieStr ?? "").toMatch(/trading_session=/);
  });
});

describe("gated routes (signed in)", () => {
  it("/dashboard renders with the account block", async () => {
    const account: AccountInfo = {
      accountId: "test",
      accountType: "demo",
      currency: "USD",
      equityUsd: 12345,
      balanceUsd: 12000,
      marginUsedUsd: 0,
      marginFreeUsd: 12345,
      openPositionsCount: 0,
      totalOpenRiskPct: 0,
      unrealizedPnlUsd: 50,
      unrealizedPnlPct: 0.4,
    };
    const { app, cookie } = await buildAndAuth(
      baseDeps({ accountInfo: async () => account }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Dashboard");
    expect(res.body).toContain("12,345.00");
    expect(res.body).toContain("DEMO");
  });

  it("/dashboard shows open positions", async () => {
    const pos: Position = {
      id: "p1",
      sessionId: "s1",
      originatingSignalId: "sig",
      originatingStrategy: "asian-range-sweep",
      instrument: "EURUSD",
      direction: "long",
      entryPrice: 1.1,
      entryTime: new Date(),
      currentStopPrice: 1.09,
      currentTargetPrice: 1.12,
      lotSize: 0.1,
      notionalUsd: 11000,
      initialRiskPct: 0.1,
      initialRiskUsd: 100,
      frictionPaidUsd: { spread: 0, slippage: 0, commission: 0, swap: 0 },
      unrealizedPnLUsd: 25,
      unrealizedPnLPct: 0.025,
      brokerOrderId: null,
      brokerPositionId: "p1",
    };
    const { app, cookie } = await buildAndAuth(
      baseDeps({ openPositions: async () => [pos] }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie },
    });
    expect(res.body).toContain("EURUSD");
    expect(res.body).toContain("LONG");
    expect(res.body).toContain("asian-range-sweep");
  });

  it("/config renders the risk-config form with current values", async () => {
    const { app, cookie } = await buildAndAuth(baseDeps());
    const res = await app.inject({
      method: "GET",
      url: "/config",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="riskPerTradePct"');
    expect(res.body).toContain(`value="${DEFAULT_RISK_CONFIG.riskPerTradePct}"`);
  });

  it("/backtests renders an empty state when there are no sessions", async () => {
    const { app, cookie } = await buildAndAuth(baseDeps());
    const res = await app.inject({
      method: "GET",
      url: "/backtests",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("No backtest sessions yet");
  });
});

describe("emergency stop POST", () => {
  it("returns 401 when runtimeOps is null", async () => {
    const { app, cookie } = await buildAndAuth(baseDeps({ runtimeOps: null }));
    const res = await app.inject({
      method: "POST",
      url: "/api/emergency-stop",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it("invokes RuntimeOps.emergencyStop and returns a confirmation page", async () => {
    let called = false;
    const fakeRuntimeOps = {
      states: () => ({}),
      isPaused: () => false,
      async pauseStrategy() {},
      async resumeStrategy() {},
      async killStrategy() {
        return 0;
      },
      async emergencyStop() {
        called = true;
        return {
          startedAtMs: 0,
          finishedAtMs: 5,
          durationMs: 5,
          withinDeadline: true,
          strategiesHalted: ["s1"],
          positionsClosed: 0,
          failures: [],
        };
      },
      async submitManualOrder() {
        throw new Error("unused");
      },
      async closeManualPosition() {
        throw new Error("unused");
      },
      async reloadRiskConfig() {},
      async loadPersistedRiskConfig() {
        return null;
      },
    };
    const { app, cookie } = await buildAndAuth(
      baseDeps({
        runtimeOps: fakeRuntimeOps as unknown as ServerDeps["runtimeOps"],
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/emergency-stop",
      headers: { cookie },
    });
    expect(called).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Emergency stop completed");
    expect(res.body).toContain("Halted 1 strategies");
  });
});

describe("/api/health", () => {
  it("is reachable without auth", async () => {
    const app = await buildServer(baseDeps());
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body) as { status: string; codeVersion: string };
    expect(json.codeVersion).toBe("test");
  });
});
