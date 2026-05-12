/**
 * Round-trip insert/query tests for every repository. Each test uses a
 * fresh schema (per createTestDb) so they don't interfere.
 */

import { afterEach, describe, expect, it } from "vitest";

import { buildRepos } from "../src/repos/index.js";
import type { NewBarRow } from "../src/schema/bar.js";
import type { NewSessionRow } from "../src/schema/session.js";
import { createTestDb, type TestDb } from "./helpers.js";

let tdb: TestDb | undefined;

afterEach(async () => {
  if (tdb !== undefined) {
    await tdb.cleanup();
    tdb = undefined;
  }
});

async function setup(name: string): Promise<ReturnType<typeof buildRepos>> {
  tdb = await createTestDb(name);
  return buildRepos(tdb.db);
}

function mkSession(): NewSessionRow {
  return {
    mode: "backtest",
    sessionType: "single_backtest",
    codeVersion: "test-sha",
    instruments: ["EURUSD"],
    timeframes: ["m1"],
    dateRangeFrom: new Date("2025-01-01T00:00:00Z"),
    dateRangeTo: new Date("2025-01-02T00:00:00Z"),
    strategies: [{ name: "noop", config: {} }],
    orchestratorMode: "equal_weight",
    randomSeed: 42n,
    initialEquityUsd: "100000.00",
    currentEquityUsd: "100000.00",
    riskConfig: {},
  };
}

describe("BarRepo", () => {
  it("bulk inserts with ON CONFLICT DO NOTHING", async () => {
    const repos = await setup("bar");
    const rows: NewBarRow[] = [
      {
        instrument: "EURUSD",
        timeframe: "m1",
        timestampUtc: new Date("2025-01-01T00:00:00Z"),
        open: "1.085000",
        high: "1.085500",
        low: "1.084500",
        close: "1.085200",
        volume: "100.00",
        source: "historical",
      },
      {
        instrument: "EURUSD",
        timeframe: "m1",
        timestampUtc: new Date("2025-01-01T00:01:00Z"),
        open: "1.085200",
        high: "1.086000",
        low: "1.085000",
        close: "1.085800",
        volume: "120.00",
        source: "historical",
      },
    ];

    const inserted = await repos.bars.insertMany(rows);
    expect(inserted).toBe(2);

    // Repeat insert → ON CONFLICT DO NOTHING → zero new rows.
    const dup = await repos.bars.insertMany(rows);
    expect(dup).toBe(0);

    const found = await repos.bars.findRange(
      "EURUSD",
      "m1",
      new Date("2024-01-01T00:00:00Z"),
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(found).toHaveLength(2);

    const n = await repos.bars.countByInstrumentTimeframe("EURUSD", "m1");
    expect(n).toBe(2);
  });
});

describe("SessionRepo", () => {
  it("inserts and reads back, status update round-trip", async () => {
    const repos = await setup("session");
    const created = await repos.sessions.create(mkSession());
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.status).toBe("pending");

    await repos.sessions.updateStatus(created.id, "running");
    const after = await repos.sessions.findById(created.id);
    expect(after?.status).toBe("running");
  });
});

describe("SignalLogRepo + TradeRepo", () => {
  it("links signal -> trade", async () => {
    const repos = await setup("sigtrade");
    const sess = await repos.sessions.create(mkSession());

    const signal = await repos.signals.insert({
      sessionId: sess.id,
      originatingStrategy: "asian-range-sweep",
      instrument: "EURUSD",
      direction: "long",
      proposedEntryPrice: "1.085000",
      proposedStopPrice: "1.083000",
      proposedTargetPrice: "1.090000",
      proposedSizeFraction: "0.5000",
      urgencyScore: "0.8000",
      signalType: "sweep",
      generatedAtBar: new Date("2025-01-01T08:00:00Z"),
      metadata: {},
    });

    const trade = await repos.trades.insert({
      sessionId: sess.id,
      originatingSignalId: signal.id,
      originatingStrategy: signal.originatingStrategy,
      instrument: "EURUSD",
      direction: "long",
      entryPrice: "1.085000",
      exitPrice: "1.087500",
      entryTime: new Date("2025-01-01T08:00:00Z"),
      exitTime: new Date("2025-01-01T12:00:00Z"),
      exitReason: "target",
      lotSize: "1.0000",
      notionalUsd: "108500.00",
      initialRiskPct: "1.0000",
      realizedPnlPct: "2.3000",
      realizedRMultiple: "1.2500",
      initialRiskUsd: "1000.00",
      realizedPnlUsd: "2500.00",
      initialStopPrice: "1.083000",
      initialTargetPrice: "1.090000",
      totalFrictionUsd: { spread: 5, slippage: 2, commission: 7, swap: 0 },
      holdDurationMinutes: 240,
      metadata: {},
    });

    await repos.signals.markBecameTrade(signal.id, trade.id);

    const trades = await repos.trades.findBySession(sess.id);
    expect(trades).toHaveLength(1);
    expect(trades[0]?.exitReason).toBe("target");

    const signals = await repos.signals.findBySession(sess.id);
    expect(signals[0]?.becameTradeId).toBe(trade.id);
  });
});

describe("AuditEventRepo", () => {
  it("inserts and acknowledges", async () => {
    const repos = await setup("audit");
    const sess = await repos.sessions.create(mkSession());
    const ev = await repos.audit.insert({
      sessionId: sess.id,
      severity: "info",
      category: "system",
      description: "session created",
      metadata: { source: "test" },
    });
    await repos.audit.acknowledge(ev.id);
    const rows = await repos.audit.findBySession(sess.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.acknowledgedAt).toBeInstanceOf(Date);
  });
});

describe("ValidationIssueRepo", () => {
  it("inserts many and queries by instrument", async () => {
    const repos = await setup("validation");
    const n = await repos.validation.insertMany([
      {
        instrument: "EURUSD",
        timeframe: "m1",
        issueType: "gap",
        severity: "warn",
        description: "missing minute",
      },
      {
        instrument: "EURUSD",
        timeframe: "m1",
        issueType: "ohlc_violation",
        severity: "error",
        description: "high<close",
      },
      {
        instrument: "XAUUSD",
        timeframe: "d1",
        issueType: "zero_volume",
        severity: "info",
        description: "volume=0",
      },
    ]);
    expect(n).toBe(3);

    const eurusd = await repos.validation.findRecent("EURUSD", "m1");
    expect(eurusd).toHaveLength(2);
  });
});

describe("ConfigSettingRepo", () => {
  it("upserts with previous_value tracking", async () => {
    const repos = await setup("config");
    await repos.config.set("risk.max_open_risk_pct", 3.0, "system");
    let row = await repos.config.get("risk.max_open_risk_pct");
    expect(row?.value).toBe(3);
    expect(row?.previousValue).toBeNull();

    await repos.config.set("risk.max_open_risk_pct", 5.0, "operator");
    row = await repos.config.get("risk.max_open_risk_pct");
    expect(row?.value).toBe(5);
    expect(row?.previousValue).toBe(3);
    expect(row?.updatedBy).toBe("operator");
  });
});

describe("AccountSnapshotRepo", () => {
  it("inserts and queries by time range desc", async () => {
    const repos = await setup("snapshot");
    const sess = await repos.sessions.create(mkSession());

    await repos.snapshots.insert({
      sessionId: sess.id,
      capturedAt: new Date("2025-01-01T00:00:00Z"),
      equityUsd: "100000.00",
      balanceUsd: "100000.00",
      marginUsedUsd: "0.00",
      marginFreeUsd: "100000.00",
      openPositionsCount: 0,
      totalOpenRiskPct: "0.000",
      unrealizedPnlUsd: "0.00",
      unrealizedPnlPct: "0.000",
    });
    await repos.snapshots.insert({
      sessionId: sess.id,
      capturedAt: new Date("2025-01-02T00:00:00Z"),
      equityUsd: "101000.00",
      balanceUsd: "100000.00",
      marginUsedUsd: "1000.00",
      marginFreeUsd: "99000.00",
      openPositionsCount: 1,
      totalOpenRiskPct: "1.000",
      unrealizedPnlUsd: "1000.00",
      unrealizedPnlPct: "1.000",
    });

    const rows = await repos.snapshots.findRange(
      sess.id,
      new Date("2024-12-31T00:00:00Z"),
      new Date("2025-02-01T00:00:00Z"),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.capturedAt.getTime()).toBeGreaterThan(rows[1]?.capturedAt.getTime() ?? 0);
  });
});

describe("OrderLogRepo", () => {
  it("inserts then updates status", async () => {
    const repos = await setup("order");
    const sess = await repos.sessions.create(mkSession());
    const o = await repos.orders.insert({
      sessionId: sess.id,
      orderType: "market",
      instrument: "EURUSD",
      direction: "long",
      lotSize: "1.0000",
      status: "submitted",
    });
    await repos.orders.updateStatus(o.id, "filled", {
      fillPrice: "1.085500",
      fillTime: new Date("2025-01-01T00:00:30Z"),
      brokerOrderId: "broker-123",
    });
    expect(o.status).toBe("submitted");
  });
});

describe("health", () => {
  it("returns ok against the live test DB", async () => {
    const repos = await setup("health");
    const { healthCheck } = await import("../src/health.js");
    // Need a Db handle; the repos object has it implicitly. Pull via private?
    // Easier: open a fresh handle through createDb.
    const { createDb } = await import("../src/db.js");
    const handle = createDb({
      databaseUrl: process.env["DATABASE_URL_TEST"]
        ?? "postgres://trading:trading@localhost:5432/trading_test",
      poolSize: 2,
    });
    try {
      const res = await healthCheck(handle.db);
      expect(res.ok).toBe(true);
      expect(res.postgresVersion).toMatch(/PostgreSQL/);
    } finally {
      await handle.close();
    }
    // tdb is set by setup(); cleanup happens in afterEach but only on tdb.
    // Reference repos to avoid unused-var lint.
    void repos;
  });
});
