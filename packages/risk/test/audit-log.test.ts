/**
 * AuditLog integration tests against a real DB schema.
 */

import { randomUUID } from "node:crypto";

import type { OrderRequest, Signal } from "@trading/core";
import { buildRepos } from "@trading/data";
import { createTestDb, type TestDb } from "@trading/data/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { AuditLog } from "../src/audit-log.js";

let tdb: TestDb | undefined;

afterEach(async () => {
  if (tdb !== undefined) {
    await tdb.cleanup();
    tdb = undefined;
  }
});

async function setup(suite: string): Promise<{
  log: AuditLog;
  sessionId: string;
  tdb: TestDb;
}> {
  tdb = await createTestDb(suite);
  const repos = buildRepos(tdb.db);
  const sessionId = randomUUID();
  await repos.sessions.create({
    id: sessionId,
    mode: "backtest",
    sessionType: "single_backtest",
    codeVersion: "test",
    instruments: ["EURUSD"],
    timeframes: ["d1"],
    dateRangeFrom: new Date("2024-01-01T00:00:00Z"),
    dateRangeTo: new Date("2024-12-31T00:00:00Z"),
    strategies: [{ name: "test", config: {} }],
    orchestratorMode: "equal_weight",
    randomSeed: 42n,
    initialEquityUsd: "100000.00",
    currentEquityUsd: "100000.00",
    riskConfig: {},
  });
  return { log: new AuditLog(repos, sessionId), sessionId, tdb };
}

function makeSignal(): Signal {
  return {
    id: randomUUID(),
    originatingStrategy: "test",
    instrument: "EURUSD",
    direction: "long",
    proposedEntryPrice: 1.1,
    proposedStopPrice: 1.09,
    proposedTargetPrice: 1.11,
    proposedSizeFractionOfAllocation: 0.5,
    urgencyScore: 0.7,
    signalType: "test",
    entryReason: "test",
    generatedAtBar: new Date(),
    metadata: { tag: "demo" },
  };
}

function makeOrder(signal: Signal): OrderRequest {
  return {
    clientOrderId: randomUUID(),
    signal,
    instrument: signal.instrument,
    direction: signal.direction,
    orderType: "market",
    lotSize: 0.1,
    price: signal.proposedEntryPrice,
    stopPrice: signal.proposedStopPrice,
    targetPrice: signal.proposedTargetPrice,
    originatingStrategy: signal.originatingStrategy,
    metadata: {},
  };
}

describe("AuditLog", () => {
  it("persists a signal to signal_log with rejection reason", async () => {
    const { log, sessionId, tdb: db } = await setup("audit_signal");
    const repos = buildRepos(db.db);
    const s = makeSignal();
    await log.recordSignal({
      signal: s,
      becameTrade: false,
      rejectedReason: "risk_limit",
    });
    const signals = await repos.signals.findBySession(sessionId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.instrument).toBe("EURUSD");
    expect(signals[0]?.rejectedReason).toBe("risk_limit");
    expect(signals[0]?.becameTradeId).toBeNull();
  });

  it("recordRiskLimitHit writes a warn-severity event with metadata", async () => {
    const { log, sessionId, tdb: db } = await setup("audit_risk");
    await log.recordRiskLimitHit("per_trade_risk", 2.0, 1.5);
    const repos = buildRepos(db.db);
    const rows = await repos.audit.findBySession(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.severity).toBe("warn");
    expect(rows[0]?.category).toBe("risk");
    expect(rows[0]?.description).toContain("per_trade_risk");
    expect(rows[0]?.metadata).toMatchObject({ value: 2, threshold: 1.5 });
  });

  it("recordEmergencyStop writes a fatal halt event", async () => {
    const { log, sessionId, tdb: db } = await setup("audit_estop");
    await log.recordEmergencyStop("operator", "weekly drawdown");
    const repos = buildRepos(db.db);
    const rows = await repos.audit.findBySession(sessionId);
    expect(rows[0]?.severity).toBe("fatal");
    expect(rows[0]?.category).toBe("halt");
  });

  it("acknowledgeEvent flips acknowledgedAt", async () => {
    const { log, sessionId, tdb: db } = await setup("audit_ack");
    await log.recordEvent({ severity: "info", category: "system", description: "x" });
    const repos = buildRepos(db.db);
    const [row] = await repos.audit.findBySession(sessionId);
    expect(row?.acknowledgedAt).toBeNull();
    if (row !== undefined) {
      await log.acknowledgeEvent(row.id);
    }
    const [updated] = await repos.audit.findBySession(sessionId);
    expect(updated?.acknowledgedAt).not.toBeNull();
  });

  it("eventsByCategory filters as expected", async () => {
    const { log } = await setup("audit_cat");
    await log.recordOrder(makeOrder(makeSignal()));
    await log.recordRiskLimitHit("daily", 5, 4);
    const orders = await log.eventsByCategory("order");
    const risk = await log.eventsByCategory("risk");
    expect(orders).toHaveLength(1);
    expect(risk).toHaveLength(1);
  });
});
