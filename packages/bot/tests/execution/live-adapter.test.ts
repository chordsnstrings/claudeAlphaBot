import { describe, expect, it } from "vitest";
import type { Pool } from "pg";

import type { Candle, SizedSignal } from "@hydra/shared";

import { LiveAdapter } from "../../src/execution/live-adapter.js";
import type {
  BinanceSignedRest,
  OrderResponse,
  PositionRiskRow,
} from "../../src/execution/binance-signed-rest.js";

const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2024, 0, 1);

class FakePool {
  readonly calls: { sql: string; params: unknown[] }[] = [];
  tradeId = 1;
  savedPositions = new Map<string, unknown[]>();
  /** Rows returned by the next SELECT FROM open_positions call. */
  selectPositionRows: Record<string, unknown>[] = [];
  async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ sql, params });
    if (/INSERT INTO open_positions/.test(sql)) {
      this.savedPositions.set(String(params[0]), params);
      return { rows: [] };
    }
    if (/INSERT INTO trades/.test(sql)) {
      return { rows: [{ trade_id: this.tradeId++ } as unknown as T] };
    }
    if (/DELETE FROM open_positions/.test(sql)) {
      this.savedPositions.delete(String(params[0]));
      return { rows: [] };
    }
    if (/SELECT[\s\S]*FROM open_positions/.test(sql)) {
      return { rows: this.selectPositionRows as unknown as T[] };
    }
    return { rows: [] };
  }
}

class FakeBinance implements Partial<BinanceSignedRest> {
  placedEntries: { qty: number; direction: string; symbol: string }[] = [];
  placedStops: { stopPrice: number; qty: number; closeSide: string }[] = [];
  placedTps: { stopPrice: number; qty: number; closeSide: string }[] = [];
  cancelled: { symbol: string; id: string }[] = [];
  positionRiskRows: PositionRiskRow[] = [];

  async placeMarketEntry(p: {
    symbol: string;
    direction: string;
    quantity: number;
  }): Promise<OrderResponse> {
    this.placedEntries.push({ qty: p.quantity, direction: p.direction, symbol: p.symbol });
    return {
      orderId: 1000 + this.placedEntries.length,
      symbol: p.symbol,
      status: "FILLED",
      clientOrderId: "c",
      price: "0",
      avgPrice: "100",
      origQty: String(p.quantity),
      executedQty: String(p.quantity),
      type: "MARKET",
      side: p.direction === "LONG" ? "BUY" : "SELL",
    };
  }
  async placeStopMarket(p: {
    closeSide: string;
    stopPrice: number;
    quantity: number;
  }): Promise<OrderResponse> {
    this.placedStops.push({ stopPrice: p.stopPrice, qty: p.quantity, closeSide: p.closeSide });
    return {
      orderId: 2000 + this.placedStops.length,
      symbol: "BTCUSDT",
      status: "NEW",
      clientOrderId: "s",
      price: "0",
      origQty: String(p.quantity),
      executedQty: "0",
      type: "STOP_MARKET",
      side: p.closeSide,
      reduceOnly: true,
      stopPrice: String(p.stopPrice),
    };
  }
  async placeTakeProfitMarket(p: {
    closeSide: string;
    stopPrice: number;
    quantity: number;
  }): Promise<OrderResponse> {
    this.placedTps.push({ stopPrice: p.stopPrice, qty: p.quantity, closeSide: p.closeSide });
    return {
      orderId: 3000 + this.placedTps.length,
      symbol: "BTCUSDT",
      status: "NEW",
      clientOrderId: "tp",
      price: "0",
      origQty: String(p.quantity),
      executedQty: "0",
      type: "TAKE_PROFIT_MARKET",
      side: p.closeSide,
      reduceOnly: true,
      stopPrice: String(p.stopPrice),
    };
  }
  async cancelOrder(symbol: string, orderId: string): Promise<OrderResponse> {
    this.cancelled.push({ symbol, id: orderId });
    return {
      orderId: Number(orderId),
      symbol,
      status: "CANCELED",
      clientOrderId: "x",
      price: "0",
      origQty: "0",
      executedQty: "0",
      type: "STOP_MARKET",
      side: "BUY",
    };
  }
  async getPositionRisk(): Promise<readonly PositionRiskRow[]> {
    return this.positionRiskRows;
  }
}

const asPool = (p: FakePool) => p as unknown as Pool;
const asRest = (r: FakeBinance) => r as unknown as BinanceSignedRest;

function dbRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "BTCUSDT-t-ARB",
    mode: "live",
    strategy: "ARB",
    symbol: "BTCUSDT",
    direction: "LONG",
    entry_time: "1",
    entry_price: "100",
    quantity: "1",
    remaining_quantity: "1",
    notional_usd: "100",
    stop_price: "98",
    tp1_price: "103",
    tp2_price: "106",
    breakeven_trigger_price: "102",
    time_stop_utc: "99999999999",
    tp1_filled: false,
    breakeven_moved: false,
    fees_paid_usd: "0.04",
    realized_pnl_usd: "0",
    exchange_order_ids: null,
    ...overrides,
  };
}

function signal(overrides: Partial<SizedSignal> = {}): SizedSignal {
  return {
    strategy: "ARB",
    symbol: "BTCUSDT",
    direction: "LONG",
    generatedAt: T0,
    entryPrice: 100,
    stopPrice: 98,
    tp1Price: 103,
    tp2Price: 106,
    tp1AllocationPct: 50,
    breakevenTriggerPrice: 102,
    timeStopUtc: T0 + 12 * HOUR_MS,
    reasoning: "test",
    quantity: 1,
    notionalUsd: 100,
    riskUsd: 2,
    marginUsd: 10,
    leverage: 10,
    ...overrides,
  };
}

function candle(h: number, l: number): Candle {
  return {
    symbol: "BTCUSDT",
    openTime: T0 + HOUR_MS,
    closeTime: T0 + HOUR_MS * 2 - 1,
    open: 100,
    high: h,
    low: l,
    close: (h + l) / 2,
    volume: 1,
  };
}

describe("LiveAdapter.submitEntry", () => {
  it("places MARKET entry + STOP_MARKET + TAKE_PROFIT_MARKET brackets (reduceOnly)", async () => {
    const pool = new FakePool();
    const rest = new FakeBinance();
    const a = new LiveAdapter({ pool: asPool(pool), rest: asRest(rest) });
    const r = await a.submitEntry(signal(), T0);

    expect(rest.placedEntries.length).toBe(1);
    expect(rest.placedStops.length).toBe(1);
    expect(rest.placedTps.length).toBe(1);
    expect(rest.placedStops[0]!.closeSide).toBe("SELL"); // close LONG
    expect(rest.placedStops[0]!.stopPrice).toBe(98);
    expect(rest.placedTps[0]!.stopPrice).toBe(106);
    expect(r.position.mode).toBe("live");
    expect(r.position.exchangeOrderIds?.length).toBe(3);
  });

  it("uses SELL entry side for SHORT position, BUY bracket closes", async () => {
    const pool = new FakePool();
    const rest = new FakeBinance();
    const a = new LiveAdapter({ pool: asPool(pool), rest: asRest(rest) });
    await a.submitEntry(signal({ direction: "SHORT" }), T0);
    expect(rest.placedEntries[0]!.direction).toBe("SHORT");
    expect(rest.placedStops[0]!.closeSide).toBe("BUY");
  });
});

describe("LiveAdapter.checkExits", () => {
  it("no exchange delta = no events (position still open)", async () => {
    const pool = new FakePool();
    const rest = new FakeBinance();
    const a = new LiveAdapter({ pool: asPool(pool), rest: asRest(rest) });
    const r = await a.submitEntry(signal(), T0);
    rest.positionRiskRows = [
      {
        symbol: "BTCUSDT",
        positionAmt: "1",
        entryPrice: "100",
        markPrice: "101",
        unRealizedProfit: "1",
        leverage: "10",
      },
    ];
    const events = await a.checkExits({
      position: r.position,
      candle: candle(101, 99),
      accountEquityBefore: 10_000,
      nowUtc: T0 + HOUR_MS,
    });
    expect(events).toEqual([]);
  });

  it("exchange qty=0 → emits TP2 event, cancels surviving bracket, deletes position", async () => {
    const pool = new FakePool();
    const rest = new FakeBinance();
    const a = new LiveAdapter({ pool: asPool(pool), rest: asRest(rest) });
    const r = await a.submitEntry(signal(), T0);
    // Position closed upstream (bracket fired)
    rest.positionRiskRows = [
      {
        symbol: "BTCUSDT",
        positionAmt: "0",
        entryPrice: "100",
        markPrice: "106",
        unRealizedProfit: "0",
        leverage: "10",
      },
    ];
    const events = await a.checkExits({
      position: r.position,
      candle: candle(107, 99),
      accountEquityBefore: 10_000,
      nowUtc: T0 + HOUR_MS,
    });
    expect(events.length).toBe(1);
    expect(events[0]!.exitReason).toBe("TP2");
    expect(events[0]!.fullyClosed).toBe(true);
    expect(events[0]!.trade!.mode).toBe("live");
    // One of the brackets should have been cancelled (the stop, since TP fired)
    expect(rest.cancelled.length).toBeGreaterThanOrEqual(1);
  });

  it("triggers TIME_STOP close when candle reaches timeStopUtc and position still open", async () => {
    const pool = new FakePool();
    const rest = new FakeBinance();
    const a = new LiveAdapter({ pool: asPool(pool), rest: asRest(rest) });
    const r = await a.submitEntry(
      signal({ timeStopUtc: T0 + 2 * HOUR_MS }),
      T0,
    );
    rest.positionRiskRows = [
      { symbol: "BTCUSDT", positionAmt: "1", entryPrice: "100", markPrice: "101",
        unRealizedProfit: "0", leverage: "10" },
    ];
    const events = await a.checkExits({
      position: r.position,
      candle: {
        symbol: "BTCUSDT",
        openTime: T0 + 2 * HOUR_MS,
        closeTime: T0 + 3 * HOUR_MS - 1,
        open: 100, high: 101, low: 99, close: 100, volume: 1,
      },
      accountEquityBefore: 10_000,
      nowUtc: T0 + 2 * HOUR_MS,
    });
    expect(events.length).toBe(1);
    expect(events[0]!.exitReason).toBe("TIME_STOP");
  });
});

describe("LiveAdapter.reconcile", () => {
  it("drops DB positions that no longer exist upstream", async () => {
    const pool = new FakePool();
    pool.selectPositionRows = [dbRow({})];
    const rest = new FakeBinance();
    rest.positionRiskRows = []; // nothing upstream
    const a = new LiveAdapter({ pool: asPool(pool), rest: asRest(rest) });
    const reconciled = await a.reconcile();
    expect(reconciled).toEqual([]);
    expect(pool.calls.some((c) => /DELETE FROM open_positions/.test(c.sql))).toBe(true);
  });

  it("keeps DB positions that match upstream, updates partial quantities", async () => {
    const pool = new FakePool();
    pool.selectPositionRows = [dbRow({})];
    const rest = new FakeBinance();
    rest.positionRiskRows = [
      { symbol: "BTCUSDT", positionAmt: "0.5", entryPrice: "100", markPrice: "102",
        unRealizedProfit: "1", leverage: "10" },
    ];
    const a = new LiveAdapter({ pool: asPool(pool), rest: asRest(rest) });
    const reconciled = await a.reconcile();
    expect(reconciled.length).toBe(1);
    expect(reconciled[0]!.remainingQuantity).toBeCloseTo(0.5);
  });
});
