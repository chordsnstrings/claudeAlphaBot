/**
 * Integration test for Phase 5 — drive TradingSystem with stub adapters
 * over 252 real EURUSD daily bars stored in the test DB. Verifies:
 *   - The event loop completes without error
 *   - The stub strategy is called for every bar of its instrument/timeframe
 *   - Signals from the strategy flow through orchestrator/risk/execution
 *     and the audit log records them with the right becameTrade flag
 *
 * No mocks are used to short-circuit the system under test: the DB write,
 * the BarRepo query, the AsyncIterable stream, the indicator computation,
 * and the audit calls all run for real.
 */

import { randomUUID } from "node:crypto";

import {
  type AccountInfo,
  type AuditLog,
  type Bar,
  type Clock,
  type ExecutionAdapter,
  type MarketDataFeed,
  type MarketState,
  type MetricsCollector,
  type OrderRequest,
  type OrderResult,
  type OrderUpdate,
  type Orchestrator,
  type Position,
  type RiskManager,
  type Signal,
  type Strategy,
  type StrategyConfig,
  type StrategyContext,
  type Timeframe,
} from "@trading/core";
import { buildRepos } from "@trading/data";
import { createTestDb, type TestDb } from "@trading/data/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { TradingSystem } from "../src/trading-system.js";

// ----------------------------- Stub adapters -----------------------------

class StubDataFeed implements MarketDataFeed {
  private connected = false;
  private cur: Bar | null = null;

  constructor(private readonly bars: readonly Bar[]) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async start(): Promise<void> {
    this.connected = true;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async stop(): Promise<void> {
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }
  getCurrentBar(): Bar | null {
    return this.cur;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async getHistoricalBars(): Promise<Bar[]> {
    return [...this.bars];
  }
  async *subscribe(instrument: string, timeframe: Timeframe): AsyncIterable<Bar> {
    for (const b of this.bars) {
      if (b.instrument === instrument && b.timeframe === timeframe) {
        this.cur = b;
        // Yield asynchronously to exercise the await path.
        await Promise.resolve();
        yield b;
      }
    }
  }
}

class StubExecutionAdapter implements ExecutionAdapter {
  public readonly submitted: OrderRequest[] = [];
  private equity = 100_000;
  private connected = false;

  // eslint-disable-next-line @typescript-eslint/require-await
  async start(): Promise<void> {
    this.connected = true;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async stop(): Promise<void> {
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async submitOrder(order: OrderRequest): Promise<OrderResult> {
    this.submitted.push(order);
    return {
      orderId: randomUUID(),
      clientOrderId: order.clientOrderId,
      status: "filled",
      fillPrice: order.price ?? order.stopPrice,
      fillTime: new Date(),
      filledLots: order.lotSize,
      rejectionReason: null,
      brokerPositionId: randomUUID(),
    };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async cancelOrder(): Promise<void> {
    /* no-op */
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async modifyOrder(orderId: string): Promise<OrderResult> {
    return {
      orderId,
      clientOrderId: orderId,
      status: "accepted",
      fillPrice: null,
      fillTime: null,
      filledLots: 0,
      rejectionReason: null,
      brokerPositionId: null,
    };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async closePosition(positionId: string): Promise<OrderResult> {
    return {
      orderId: positionId,
      clientOrderId: positionId,
      status: "filled",
      fillPrice: 0,
      fillTime: new Date(),
      filledLots: 0,
      rejectionReason: null,
      brokerPositionId: positionId,
    };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async getOpenPositions(): Promise<Position[]> {
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async getAccountInfo(): Promise<AccountInfo> {
    return {
      accountId: "test",
      accountType: "backtest",
      currency: "USD",
      equityUsd: this.equity,
      balanceUsd: this.equity,
      marginUsedUsd: 0,
      marginFreeUsd: this.equity,
      openPositionsCount: 0,
      totalOpenRiskPct: 0,
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
    };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async *subscribeOrderUpdates(): AsyncIterable<OrderUpdate> {
    /* none in this fixture */
  }
}

class StubClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  advanceTo(d: Date): void {
    this.current = d;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async sleep(): Promise<void> {
    /* no-op in tests */
  }
}

class NoSignalStrategy implements Strategy {
  public readonly name: string;
  public readonly config: StrategyConfig;
  public initCalls = 0;
  public generateCalls = 0;
  public updateCalls = 0;
  public shutdownCalls = 0;

  constructor(config: StrategyConfig) {
    this.name = config.name;
    this.config = config;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async initialize(_ctx: StrategyContext): Promise<void> {
    this.initCalls += 1;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async generateSignals(_state: MarketState): Promise<Signal[]> {
    this.generateCalls += 1;
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async updateState(_state: MarketState): Promise<void> {
    this.updateCalls += 1;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async onPositionEvent(): Promise<void> {
    /* no-op */
  }
  getOpenPositions(): Position[] {
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }
}

class AlwaysLongStrategy extends NoSignalStrategy {
  // eslint-disable-next-line @typescript-eslint/require-await
  override async generateSignals(state: MarketState): Promise<Signal[]> {
    this.generateCalls += 1;
    // Only after indicators warm up (need rolling_high20 -> period 20)
    if (state.indicators.rollingHigh20 === null) {
      return [];
    }
    return [
      {
        id: randomUUID(),
        originatingStrategy: this.name,
        instrument: state.instrument,
        direction: "long",
        proposedEntryPrice: state.currentBar.close,
        proposedStopPrice: state.currentBar.low,
        proposedTargetPrice: state.currentBar.close * 1.001,
        proposedSizeFractionOfAllocation: 0.5,
        urgencyScore: 0.5,
        signalType: "test_long",
        entryReason: "always-long stub",
        generatedAtBar: state.currentBar.timestampUtc,
        metadata: {},
      },
    ];
  }
}

const passthroughOrchestrator: Orchestrator = {
  process(signals) {
    return signals.map((s) => ({
      clientOrderId: randomUUID(),
      signal: s,
      instrument: s.instrument,
      direction: s.direction,
      orderType: "market" as const,
      lotSize: 1,
      price: null,
      stopPrice: s.proposedStopPrice,
      targetPrice: s.proposedTargetPrice,
      originatingStrategy: s.originatingStrategy,
      metadata: {},
    }));
  },
};

const permissiveRisk: RiskManager = {
  canExecute: () => ({ allowed: true, reason: null, adjustedLotSize: null }),
  shouldHalt: () => ({ halt: false, reason: null }),
};

class CountingMetrics implements MetricsCollector {
  public updates = 0;
  update(): void {
    this.updates += 1;
  }
  snapshot(): Record<string, unknown> {
    return { updates: this.updates };
  }
}

class CountingAudit implements AuditLog {
  public signals: Array<{ becameTrade: boolean; rejectedReason?: string }> = [];
  public events = 0;
  // eslint-disable-next-line @typescript-eslint/require-await
  async recordSignal(args: { becameTrade: boolean; rejectedReason?: string }): Promise<void> {
    const entry: { becameTrade: boolean; rejectedReason?: string } = {
      becameTrade: args.becameTrade,
    };
    if (args.rejectedReason !== undefined) {
      entry.rejectedReason = args.rejectedReason;
    }
    this.signals.push(entry);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async recordEvent(): Promise<void> {
    this.events += 1;
  }
}

// ----------------------------- Fixtures ---------------------------------

function syntheticDailyBars(instrument: string, count: number): Bar[] {
  const start = Date.parse("2025-01-01T00:00:00Z");
  const out: Bar[] = [];
  let p = 1.1;
  for (let i = 0; i < count; i += 1) {
    const ts = new Date(start + i * 86_400_000);
    const drift = 0.0003 * Math.sin(i * 0.07);
    const open = p;
    p = p + drift;
    const close = p;
    const high = Math.max(open, close) + 0.0005;
    const low = Math.min(open, close) - 0.0005;
    out.push({
      instrument,
      timeframe: "d1",
      timestampUtc: ts,
      open,
      high,
      low,
      close,
      volume: 100,
      source: "historical",
    });
  }
  return out;
}

let tdb: TestDb | undefined;

afterEach(async () => {
  if (tdb !== undefined) {
    await tdb.cleanup();
    tdb = undefined;
  }
});

// ----------------------------- Tests ------------------------------------

describe("TradingSystem (Phase 5 integration)", () => {
  it("processes one year of daily EURUSD bars from a real DB without errors", async () => {
    tdb = await createTestDb("ts_noop");
    const repos = buildRepos(tdb.db);

    const bars = syntheticDailyBars("EURUSD", 252);
    await repos.bars.insertMany(
      bars.map((b) => ({
        instrument: b.instrument,
        timeframe: b.timeframe,
        timestampUtc: b.timestampUtc,
        open: b.open.toFixed(6),
        high: b.high.toFixed(6),
        low: b.low.toFixed(6),
        close: b.close.toFixed(6),
        volume: b.volume.toFixed(2),
        source: b.source,
      })),
    );

    // Read back from the DB through BarRepo to exercise the real cursor.
    const rows = await repos.bars.findRange(
      "EURUSD",
      "d1",
      new Date("2024-12-01T00:00:00Z"),
      new Date("2026-01-01T00:00:00Z"),
    );
    const realBars: Bar[] = rows.map((r) => ({
      instrument: r.instrument,
      timeframe: r.timeframe as Timeframe,
      timestampUtc: r.timestampUtc,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
      source: r.source as Bar["source"],
    }));
    expect(realBars).toHaveLength(252);

    const dataFeed = new StubDataFeed(realBars);
    const execution = new StubExecutionAdapter();
    const clock = new StubClock(realBars[0]?.timestampUtc ?? new Date());
    const strategy = new NoSignalStrategy({
      name: "noop",
      parameters: {},
      instruments: ["EURUSD"],
      timeframes: ["d1"],
      allocationFraction: 1,
      enabled: true,
    });
    const metrics = new CountingMetrics();
    const audit = new CountingAudit();

    const system = new TradingSystem({
      dataFeed,
      execution,
      clock,
      strategies: [strategy],
      orchestrator: passthroughOrchestrator,
      riskManager: permissiveRisk,
      metrics,
      auditLog: audit,
      sessionId: randomUUID(),
      mode: "backtest",
      subscriptions: [{ instrument: "EURUSD", timeframe: "d1" }],
    });

    await system.run();

    expect(strategy.initCalls).toBe(1);
    expect(strategy.shutdownCalls).toBe(1);
    expect(strategy.generateCalls).toBe(252);
    expect(strategy.updateCalls).toBe(252);
    expect(metrics.updates).toBe(252);
    expect(audit.signals).toHaveLength(0);
    expect(execution.submitted).toHaveLength(0);
    expect(system.getStats()).toHaveLength(252);
  });

  it("flows signals through orchestrator + risk + execution + audit", async () => {
    tdb = await createTestDb("ts_signals");
    const repos = buildRepos(tdb.db);

    const bars = syntheticDailyBars("EURUSD", 30);
    await repos.bars.insertMany(
      bars.map((b) => ({
        instrument: b.instrument,
        timeframe: b.timeframe,
        timestampUtc: b.timestampUtc,
        open: b.open.toFixed(6),
        high: b.high.toFixed(6),
        low: b.low.toFixed(6),
        close: b.close.toFixed(6),
        volume: b.volume.toFixed(2),
        source: b.source,
      })),
    );
    const rows = await repos.bars.findRange(
      "EURUSD",
      "d1",
      new Date("2024-12-01T00:00:00Z"),
      new Date("2026-01-01T00:00:00Z"),
    );
    const realBars: Bar[] = rows.map((r) => ({
      instrument: r.instrument,
      timeframe: r.timeframe as Timeframe,
      timestampUtc: r.timestampUtc,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
      source: r.source as Bar["source"],
    }));

    const dataFeed = new StubDataFeed(realBars);
    const execution = new StubExecutionAdapter();
    const strategy = new AlwaysLongStrategy({
      name: "always-long",
      parameters: {},
      instruments: ["EURUSD"],
      timeframes: ["d1"],
      allocationFraction: 1,
      enabled: true,
    });
    const audit = new CountingAudit();

    const system = new TradingSystem({
      dataFeed,
      execution,
      clock: new StubClock(realBars[0]?.timestampUtc ?? new Date()),
      strategies: [strategy],
      orchestrator: passthroughOrchestrator,
      riskManager: permissiveRisk,
      metrics: new CountingMetrics(),
      auditLog: audit,
      sessionId: randomUUID(),
      mode: "backtest",
      subscriptions: [{ instrument: "EURUSD", timeframe: "d1" }],
    });

    await system.run();

    // The strategy starts emitting after the 20-bar rolling-high warm-up.
    // Bars 21..30 (10 bars) should each produce one signal -> one order.
    expect(execution.submitted.length).toBe(10);
    expect(audit.signals.length).toBe(10);
    expect(audit.signals.every((s) => s.becameTrade)).toBe(true);
  });

  it("rejects orders when the risk manager denies them and records the reason", async () => {
    tdb = await createTestDb("ts_risk");
    const repos = buildRepos(tdb.db);
    const bars = syntheticDailyBars("EURUSD", 30);
    await repos.bars.insertMany(
      bars.map((b) => ({
        instrument: b.instrument,
        timeframe: b.timeframe,
        timestampUtc: b.timestampUtc,
        open: b.open.toFixed(6),
        high: b.high.toFixed(6),
        low: b.low.toFixed(6),
        close: b.close.toFixed(6),
        volume: b.volume.toFixed(2),
        source: b.source,
      })),
    );
    const rows = await repos.bars.findRange(
      "EURUSD",
      "d1",
      new Date("2024-12-01T00:00:00Z"),
      new Date("2026-01-01T00:00:00Z"),
    );
    const realBars: Bar[] = rows.map((r) => ({
      instrument: r.instrument,
      timeframe: r.timeframe as Timeframe,
      timestampUtc: r.timestampUtc,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
      source: r.source as Bar["source"],
    }));

    const denyingRisk: RiskManager = {
      canExecute: () => ({ allowed: false, reason: "test_block", adjustedLotSize: null }),
      shouldHalt: () => ({ halt: false, reason: null }),
    };

    const execution = new StubExecutionAdapter();
    const audit = new CountingAudit();
    const strategy = new AlwaysLongStrategy({
      name: "always-long",
      parameters: {},
      instruments: ["EURUSD"],
      timeframes: ["d1"],
      allocationFraction: 1,
      enabled: true,
    });

    const system = new TradingSystem({
      dataFeed: new StubDataFeed(realBars),
      execution,
      clock: new StubClock(realBars[0]?.timestampUtc ?? new Date()),
      strategies: [strategy],
      orchestrator: passthroughOrchestrator,
      riskManager: denyingRisk,
      metrics: new CountingMetrics(),
      auditLog: audit,
      sessionId: randomUUID(),
      mode: "backtest",
      subscriptions: [{ instrument: "EURUSD", timeframe: "d1" }],
    });

    await system.run();

    expect(execution.submitted).toHaveLength(0);
    expect(audit.signals.length).toBe(10);
    expect(audit.signals.every((s) => s.becameTrade === false && s.rejectedReason === "test_block")).toBe(true);
  });
});
