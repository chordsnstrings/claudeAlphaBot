/**
 * RuntimeOps integration tests against a real DB (config_setting,
 * audit_event, signal_log).
 */

import { randomUUID } from "node:crypto";

import {
  DEFAULT_RISK_CONFIG,
  type AccountInfo,
  type ExecutionAdapter,
  type OrderRequest,
  type OrderResult,
  type Position,
  type Strategy,
} from "@trading/core";
import { buildRepos } from "@trading/data";
import { createTestDb, type TestDb } from "@trading/data/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { AuditLog } from "../src/audit-log.js";
import { RiskManager } from "../src/risk-manager.js";
import { RuntimeOps } from "../src/runtime-ops.js";

let tdb: TestDb | undefined;

afterEach(async () => {
  if (tdb !== undefined) {
    await tdb.cleanup();
    tdb = undefined;
  }
});

/** Minimal Strategy stub that tracks one open position. */
function stubStrategy(name: string, positions: Position[] = []): Strategy {
  return {
    name,
    config: {
      name,
      parameters: {},
      instruments: ["EURUSD"],
      timeframes: ["d1"],
      allocationFraction: 1,
      enabled: true,
    },
    async initialize() {},
    async generateSignals() {
      return [];
    },
    async updateState() {},
    async onPositionEvent() {},
    getOpenPositions() {
      return positions;
    },
    async shutdown() {},
  };
}

/** Minimal ExecutionAdapter stub for ops tests. */
function stubExec(opts: {
  positions?: Position[];
  rejectClose?: boolean;
} = {}): ExecutionAdapter & {
  closed: string[];
  submitted: OrderRequest[];
} {
  const closed: string[] = [];
  const submitted: OrderRequest[] = [];
  const positions = opts.positions ?? [];
  return {
    closed,
    submitted,
    async start() {},
    async stop() {},
    isConnected: () => true,
    async submitOrder(order: OrderRequest): Promise<OrderResult> {
      submitted.push(order);
      return {
        orderId: randomUUID(),
        clientOrderId: order.clientOrderId,
        status: "filled",
        fillPrice: order.price ?? 1,
        fillTime: new Date(),
        filledLots: order.lotSize,
        rejectionReason: null,
        brokerPositionId: randomUUID(),
      };
    },
    async cancelOrder() {},
    async modifyOrder() {
      throw new Error("unused");
    },
    async closePosition(positionId: string): Promise<OrderResult> {
      if (opts.rejectClose === true) {
        throw new Error("simulated broker reject");
      }
      closed.push(positionId);
      return {
        orderId: randomUUID(),
        clientOrderId: positionId,
        status: "filled",
        fillPrice: 1,
        fillTime: new Date(),
        filledLots: 0,
        rejectionReason: null,
        brokerPositionId: positionId,
      };
    },
    async getOpenPositions(): Promise<Position[]> {
      return positions;
    },
    async getAccountInfo(): Promise<AccountInfo> {
      return {
        accountId: "test",
        accountType: "demo",
        currency: "USD",
        equityUsd: 100_000,
        balanceUsd: 100_000,
        marginUsedUsd: 0,
        marginFreeUsd: 100_000,
        openPositionsCount: positions.length,
        totalOpenRiskPct: 0,
        unrealizedPnlUsd: 0,
        unrealizedPnlPct: 0,
      };
    },
    async *subscribeOrderUpdates(): AsyncIterable<never> {},
  };
}

function pos(strategy: string, id: string): Position {
  return {
    id,
    sessionId: "live",
    originatingSignalId: "sig",
    originatingStrategy: strategy,
    instrument: "EURUSD",
    direction: "long",
    entryPrice: 1.1,
    entryTime: new Date(),
    currentStopPrice: 1.09,
    currentTargetPrice: 1.12,
    lotSize: 0.1,
    notionalUsd: 11_000,
    initialRiskPct: 0.1,
    initialRiskUsd: 100,
    frictionPaidUsd: { spread: 0, slippage: 0, commission: 0, swap: 0 },
    unrealizedPnLUsd: 0,
    unrealizedPnLPct: 0,
    brokerOrderId: null,
    brokerPositionId: id,
  };
}

async function setup(suite: string) {
  tdb = await createTestDb(suite);
  const repos = buildRepos(tdb.db);
  const sessionId = randomUUID();
  await repos.sessions.create({
    id: sessionId,
    mode: "live",
    sessionType: "live_demo",
    codeVersion: "test",
    instruments: ["EURUSD"],
    timeframes: ["m1"],
    dateRangeFrom: new Date(),
    dateRangeTo: new Date(),
    strategies: [{ name: "s1", config: {} }],
    orchestratorMode: "equal_weight",
    randomSeed: 1n,
    initialEquityUsd: "100000.00",
    currentEquityUsd: "100000.00",
    riskConfig: DEFAULT_RISK_CONFIG,
  });
  const auditLog = new AuditLog(repos, sessionId);
  const rm = new RiskManager({
    config: DEFAULT_RISK_CONFIG,
    initialEquityUsd: 100_000,
  });
  return { repos, sessionId, auditLog, rm };
}

describe("RuntimeOps", () => {
  it("pause + resume flips state and audits both", async () => {
    const { repos, auditLog, rm, sessionId } = await setup("ops_pause");
    const ops = new RuntimeOps({
      execution: stubExec(),
      riskManager: rm,
      auditLog,
      configRepo: repos.config,
      strategies: new Map([["s1", stubStrategy("s1")]]),
      accountEquityUsd: async () => 100_000,
      applyRiskConfig: () => undefined,
    });
    expect(ops.isPaused("s1")).toBe(false);
    await ops.pauseStrategy("s1", "operator", "manual pause");
    expect(ops.isPaused("s1")).toBe(true);
    await ops.resumeStrategy("s1", "operator");
    expect(ops.isPaused("s1")).toBe(false);
    const events = await repos.audit.findBySession(sessionId);
    const cats = events.map((e) => e.category);
    expect(cats.filter((c) => c === "strategy").length).toBe(2);
  });

  it("kill stops the strategy AND closes its positions", async () => {
    const { repos, auditLog, rm } = await setup("ops_kill");
    const positions = [pos("s1", "p1"), pos("s1", "p2")];
    const exec = stubExec({ positions });
    const ops = new RuntimeOps({
      execution: exec,
      riskManager: rm,
      auditLog,
      configRepo: repos.config,
      strategies: new Map([["s1", stubStrategy("s1", positions)]]),
      accountEquityUsd: async () => 100_000,
      applyRiskConfig: () => undefined,
    });
    const closed = await ops.killStrategy("s1", "operator", "test");
    expect(closed).toBe(2);
    expect(exec.closed).toEqual(["p1", "p2"]);
    expect(ops.isPaused("s1")).toBe(true);
    await expect(ops.resumeStrategy("s1", "operator")).rejects.toThrow(/killed/u);
  });

  it("emergencyStop halts strategies and closes all open positions", async () => {
    const { repos, auditLog, rm, sessionId } = await setup("ops_estop");
    const positions = [pos("s1", "p1"), pos("s2", "p2")];
    const exec = stubExec({ positions });
    const ops = new RuntimeOps({
      execution: exec,
      riskManager: rm,
      auditLog,
      configRepo: repos.config,
      strategies: new Map([
        ["s1", stubStrategy("s1")],
        ["s2", stubStrategy("s2")],
      ]),
      accountEquityUsd: async () => 100_000,
      applyRiskConfig: () => undefined,
    });
    const report = await ops.emergencyStop("operator", "drawdown breach");
    expect(report.strategiesHalted.sort()).toEqual(["s1", "s2"]);
    expect(report.positionsClosed).toBe(2);
    expect(report.withinDeadline).toBe(true);
    expect(report.failures).toEqual([]);
    expect(exec.closed.sort()).toEqual(["p1", "p2"]);
    const events = await repos.audit.findBySession(sessionId);
    expect(events.some((e) => e.severity === "fatal" && e.category === "halt")).toBe(
      true,
    );
  });

  it("submitManualOrder routes through risk check + audit log", async () => {
    const { repos, auditLog, rm } = await setup("ops_manual");
    const exec = stubExec();
    const ops = new RuntimeOps({
      execution: exec,
      riskManager: rm,
      auditLog,
      configRepo: repos.config,
      strategies: new Map(),
      accountEquityUsd: async () => 100_000,
      applyRiskConfig: () => undefined,
    });
    const result = await ops.submitManualOrder("operator", {
      instrument: "EURUSD",
      direction: "long",
      orderType: "market",
      lotSize: 0.1,
      price: 1.1,
      stopPrice: 1.09,
      targetPrice: 1.12,
      reason: "fade the spike",
    });
    expect(result.status).toBe("filled");
    expect(exec.submitted).toHaveLength(1);
    expect(exec.submitted[0]?.metadata).toMatchObject({ manual: true, by: "operator" });
  });

  it("submitManualOrder is rejected by RiskManager when sized too aggressively", async () => {
    const { repos, auditLog, rm } = await setup("ops_manual_reject");
    const exec = stubExec();
    const ops = new RuntimeOps({
      execution: exec,
      riskManager: rm,
      auditLog,
      configRepo: repos.config,
      strategies: new Map(),
      accountEquityUsd: async () => 100_000,
      applyRiskConfig: () => undefined,
    });
    // 5 lots * 100 pips = $5000 risk = 5% of $100k > 1.5% per-trade cap.
    const result = await ops.submitManualOrder("operator", {
      instrument: "EURUSD",
      direction: "long",
      orderType: "market",
      lotSize: 5,
      price: 1.1,
      stopPrice: 1.09,
      targetPrice: 1.12,
      reason: "oversized",
    });
    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toContain("per_trade_risk");
    expect(exec.submitted).toHaveLength(0);
  });

  it("reloadRiskConfig persists + calls applyRiskConfig + records audit", async () => {
    const { repos, auditLog, rm, sessionId } = await setup("ops_riskreload");
    let applied: typeof DEFAULT_RISK_CONFIG | null = null;
    const ops = new RuntimeOps({
      execution: stubExec(),
      riskManager: rm,
      auditLog,
      configRepo: repos.config,
      strategies: new Map(),
      accountEquityUsd: async () => 100_000,
      applyRiskConfig: (c) => {
        applied = c;
      },
    });
    const next = { ...DEFAULT_RISK_CONFIG, riskPerTradePct: 0.5 };
    await ops.reloadRiskConfig("operator", next);
    expect(applied).toEqual(next);
    const row = await repos.config.get("risk.config");
    expect((row?.value as { riskPerTradePct: number }).riskPerTradePct).toBe(0.5);
    const events = await repos.audit.findBySession(sessionId);
    expect(events.some((e) => e.category === "config")).toBe(true);
  });
});
