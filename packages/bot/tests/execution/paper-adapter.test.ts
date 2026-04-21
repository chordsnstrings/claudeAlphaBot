import { describe, expect, it } from "vitest";
import type { Pool } from "pg";

import type { Candle, SizedSignal } from "@hydra/shared";

import { PaperAdapter } from "../../src/execution/paper-adapter.js";

const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2024, 0, 1);

/** In-memory Pool mock that captures SQL calls and returns configurable rows. */
class FakePool {
  readonly calls: { sql: string; params: unknown[] }[] = [];
  nextTradeId = 42;

  // Pretend to be a pg Pool. Only `query` is used by the adapter.
  async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ sql, params });
    if (/INSERT INTO trades/.test(sql)) {
      const row = { trade_id: this.nextTradeId++ };
      return { rows: [row as unknown as T] };
    }
    if (/SELECT[\s\S]*FROM open_positions/.test(sql)) {
      return { rows: [] };
    }
    return { rows: [] };
  }
}

function asPool(p: FakePool): Pool {
  return p as unknown as Pool;
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

describe("PaperAdapter", () => {
  it("submitEntry upserts a position with mode='paper'", async () => {
    const pool = new FakePool();
    const a = new PaperAdapter({ pool: asPool(pool) });
    const r = await a.submitEntry(signal(), T0);
    expect(r.position.mode).toBe("paper");
    expect(pool.calls.some((c) => /INSERT INTO open_positions/.test(c.sql))).toBe(true);
  });

  it("checkExits on TP2 writes a trade row with mode='paper' and deletes position", async () => {
    const pool = new FakePool();
    const a = new PaperAdapter({ pool: asPool(pool) });
    const r = await a.submitEntry(signal(), T0);
    const events = await a.checkExits({
      position: r.position,
      candle: candle(107, 99),
      accountEquityBefore: 10_000,
      nowUtc: T0 + HOUR_MS,
    });
    expect(events.length).toBe(1);
    expect(events[0]!.exitReason).toBe("TP2");
    expect(events[0]!.trade!.mode).toBe("paper");
    expect(events[0]!.trade!.tradeId).toBe(42);
    const sawInsertTrade = pool.calls.some((c) => /INSERT INTO trades/.test(c.sql));
    const sawDelete = pool.calls.some((c) => /DELETE FROM open_positions/.test(c.sql));
    expect(sawInsertTrade).toBe(true);
    expect(sawDelete).toBe(true);
  });

  it("checkExits on TP1 upserts updated position (no trade row yet)", async () => {
    const pool = new FakePool();
    const a = new PaperAdapter({ pool: asPool(pool) });
    const r = await a.submitEntry(signal(), T0);
    pool.calls.length = 0;
    const events = await a.checkExits({
      position: r.position,
      candle: candle(103.5, 99),
      accountEquityBefore: 10_000,
      nowUtc: T0 + HOUR_MS,
    });
    expect(events[0]!.fullyClosed).toBe(false);
    expect(events[0]!.trade).toBeUndefined();
    expect(pool.calls.some((c) => /INSERT INTO trades/.test(c.sql))).toBe(false);
    expect(pool.calls.some((c) => /INSERT INTO open_positions/.test(c.sql))).toBe(true);
  });

  it("closePosition writes a trade row + deletes position", async () => {
    const pool = new FakePool();
    const a = new PaperAdapter({ pool: asPool(pool) });
    const r = await a.submitEntry(signal(), T0);
    pool.calls.length = 0;
    const e = await a.closePosition(r.position, "MANUAL", T0 + HOUR_MS, 10_000);
    expect(e.exitReason).toBe("MANUAL");
    expect(e.trade!.mode).toBe("paper");
    expect(pool.calls.some((c) => /DELETE FROM open_positions/.test(c.sql))).toBe(true);
  });
});
