/**
 * SimulatedExecutionAdapter integration tests — real DB, real friction
 * model, real trade persistence.
 */

import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import type {
  Bar,
  OrderRequest,
  Position,
  Signal,
} from "@trading/core";
import { buildRepos } from "@trading/data";
import { createTestDb, type TestDb } from "@trading/data/test-utils";

import { FrictionModel } from "../src/friction/friction-model.js";
import { SimulatedExecutionAdapter } from "../src/simulated-execution-adapter.js";

let tdb: TestDb | undefined;

afterEach(async () => {
  if (tdb !== undefined) {
    await tdb.cleanup();
    tdb = undefined;
  }
});

function mkBar(
  instrument: string,
  isoTs: string,
  open: number,
  high: number,
  low: number,
  close: number,
): Bar {
  return {
    instrument,
    timeframe: "d1",
    timestampUtc: new Date(isoTs),
    open,
    high,
    low,
    close,
    volume: 100,
    source: "historical",
  };
}

function mkSignal(
  instrument: string,
  direction: "long" | "short",
  entry: number,
  stop: number,
  target: number,
): Signal {
  return {
    id: randomUUID(),
    originatingStrategy: "test-strategy",
    instrument,
    direction,
    proposedEntryPrice: entry,
    proposedStopPrice: stop,
    proposedTargetPrice: target,
    proposedSizeFractionOfAllocation: 1,
    urgencyScore: 0.5,
    signalType: "test",
    entryReason: "unit-test",
    generatedAtBar: new Date(),
    metadata: {},
  };
}

function mkOrder(signal: Signal, lotSize: number): OrderRequest {
  return {
    clientOrderId: randomUUID(),
    signal,
    instrument: signal.instrument,
    direction: signal.direction,
    orderType: "market",
    lotSize,
    price: null,
    stopPrice: signal.proposedStopPrice,
    targetPrice: signal.proposedTargetPrice,
    originatingStrategy: signal.originatingStrategy,
    metadata: {},
  };
}

async function setup(suite: string): Promise<{
  adapter: SimulatedExecutionAdapter;
  sessionId: string;
  insertSession: (id: string) => Promise<void>;
}> {
  tdb = await createTestDb(suite);
  const repos = buildRepos(tdb.db);
  const friction = new FrictionModel({
    profile: "pepperstone_razor",
    randomSeed: 42n,
    newsEvents: [],
  });
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
    strategies: [{ name: "test-strategy", config: {} }],
    orchestratorMode: "equal_weight",
    randomSeed: 42n,
    initialEquityUsd: "100000.00",
    currentEquityUsd: "100000.00",
    riskConfig: {},
  });
  const adapter = new SimulatedExecutionAdapter({
    repos,
    friction,
    sessionId,
    initialEquityUsd: 100_000,
  });
  await adapter.start();
  return {
    adapter,
    sessionId,
    insertSession: async (_id: string) => {
      // already inserted
    },
  };
}

describe("SimulatedExecutionAdapter", () => {
  it("submitOrder rejects when no bar has been observed yet", async () => {
    const { adapter } = await setup("sea_no_bar");
    const result = await adapter.submitOrder(
      mkOrder(mkSignal("EURUSD", "long", 1.1, 1.09, 1.12), 0.1),
    );
    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBe("no_bar_seen_yet");
    await adapter.stop();
  });

  it("opens a long position and updates account info", async () => {
    const { adapter } = await setup("sea_open");
    await adapter.processBar(mkBar("EURUSD", "2024-06-01T00:00:00Z", 1.1, 1.105, 1.099, 1.1));
    const result = await adapter.submitOrder(
      mkOrder(mkSignal("EURUSD", "long", 1.1, 1.09, 1.12), 0.1),
    );
    expect(result.status).toBe("filled");
    expect(result.brokerPositionId).not.toBeNull();
    const acc = await adapter.getAccountInfo();
    expect(acc.openPositionsCount).toBe(1);
    expect(acc.equityUsd).toBeLessThan(100_000); // entry friction reduced equity
    const positions = await adapter.getOpenPositions();
    expect(positions).toHaveLength(1);
    const p = positions[0] as Position;
    expect(p.direction).toBe("long");
    expect(p.frictionPaidUsd.commission).toBeGreaterThan(0);
    await adapter.stop();
  });

  it("detects stop hit on a long position", async () => {
    const { adapter } = await setup("sea_stop");
    await adapter.processBar(mkBar("EURUSD", "2024-06-01T00:00:00Z", 1.1, 1.105, 1.099, 1.1));
    await adapter.submitOrder(mkOrder(mkSignal("EURUSD", "long", 1.1, 1.09, 1.12), 0.1));

    // Next bar: low drops to 1.085 -> below stop 1.09 -> stop hit.
    const updates = await adapter.processBar(
      mkBar("EURUSD", "2024-06-02T00:00:00Z", 1.1, 1.101, 1.085, 1.099),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.status).toBe("filled");
    // Friction adjusts the raw stop by slippage + half spread; tolerance < 1 pip.
    expect(updates[0]?.fillPrice).toBeCloseTo(1.09, 3);
    expect(await adapter.getOpenPositions()).toHaveLength(0);
    await adapter.stop();
  });

  it("detects target hit on a long position", async () => {
    const { adapter } = await setup("sea_target");
    await adapter.processBar(mkBar("EURUSD", "2024-06-01T00:00:00Z", 1.1, 1.105, 1.099, 1.1));
    await adapter.submitOrder(mkOrder(mkSignal("EURUSD", "long", 1.1, 1.09, 1.12), 0.1));

    const updates = await adapter.processBar(
      mkBar("EURUSD", "2024-06-02T00:00:00Z", 1.1, 1.121, 1.099, 1.115),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.fillPrice).toBeCloseTo(1.12, 3);
    await adapter.stop();
  });

  it("on both-hit assumes stop first (conservative)", async () => {
    const { adapter } = await setup("sea_both");
    await adapter.processBar(mkBar("EURUSD", "2024-06-01T00:00:00Z", 1.1, 1.105, 1.099, 1.1));
    await adapter.submitOrder(mkOrder(mkSignal("EURUSD", "long", 1.1, 1.09, 1.12), 0.1));

    // Bar slams to both sides — both stop and target reached.
    const updates = await adapter.processBar(
      mkBar("EURUSD", "2024-06-02T00:00:00Z", 1.1, 1.121, 1.085, 1.1),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.fillPrice).toBeCloseTo(1.09, 3);
    await adapter.stop();
  });

  it("shorts: stop is high above, target is below", async () => {
    const { adapter } = await setup("sea_short");
    await adapter.processBar(mkBar("EURUSD", "2024-06-01T00:00:00Z", 1.1, 1.105, 1.099, 1.1));
    await adapter.submitOrder(mkOrder(mkSignal("EURUSD", "short", 1.1, 1.11, 1.085), 0.1));

    // Bar high reaches 1.111 -> short stop hit.
    const updates = await adapter.processBar(
      mkBar("EURUSD", "2024-06-02T00:00:00Z", 1.1, 1.111, 1.099, 1.105),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.fillPrice).toBeCloseTo(1.11, 3);
    await adapter.stop();
  });

  it("persists a trade row to the DB on position close", async () => {
    tdb = await createTestDb("sea_persist");
    const repos = buildRepos(tdb.db);
    const friction = new FrictionModel({
      profile: "pepperstone_razor",
      randomSeed: 42n,
      newsEvents: [],
    });
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
      strategies: [{ name: "test-strategy", config: {} }],
      orchestratorMode: "equal_weight",
      randomSeed: 42n,
      initialEquityUsd: "100000.00",
      currentEquityUsd: "100000.00",
      riskConfig: {},
    });
    const adapter = new SimulatedExecutionAdapter({
      repos,
      friction,
      sessionId,
      initialEquityUsd: 100_000,
    });
    await adapter.start();

    await adapter.processBar(mkBar("EURUSD", "2024-06-01T00:00:00Z", 1.1, 1.105, 1.099, 1.1));
    await adapter.submitOrder(mkOrder(mkSignal("EURUSD", "long", 1.1, 1.09, 1.12), 0.1));
    await adapter.processBar(
      mkBar("EURUSD", "2024-06-02T00:00:00Z", 1.1, 1.121, 1.099, 1.115),
    );
    const trades = await repos.trades.findBySession(sessionId);
    expect(trades).toHaveLength(1);
    const t = trades[0];
    expect(t).toBeDefined();
    expect(t?.instrument).toBe("EURUSD");
    expect(t?.exitReason).toBe("target");
    // Friction breakdown is JSONB; cast through unknown for the test only.
    const friction_usd = t?.totalFrictionUsd as
      | { spread: number; slippage: number; commission: number; swap: number }
      | undefined;
    expect(friction_usd?.commission).toBeGreaterThan(0);
    await adapter.stop();
  });

  it("manual closePosition fills at the current bar close", async () => {
    const { adapter } = await setup("sea_manual");
    await adapter.processBar(mkBar("EURUSD", "2024-06-01T00:00:00Z", 1.1, 1.105, 1.099, 1.1));
    const r = await adapter.submitOrder(
      mkOrder(mkSignal("EURUSD", "long", 1.1, 1.09, 1.12), 0.1),
    );
    expect(r.brokerPositionId).not.toBeNull();
    if (r.brokerPositionId === null) {throw new Error("expected position id");}

    await adapter.processBar(mkBar("EURUSD", "2024-06-02T00:00:00Z", 1.1, 1.108, 1.099, 1.105));
    const close = await adapter.closePosition(r.brokerPositionId);
    expect(close.status).toBe("filled");
    expect(close.fillPrice).not.toBeNull();
    expect(await adapter.getOpenPositions()).toHaveLength(0);
    await adapter.stop();
  });
});
