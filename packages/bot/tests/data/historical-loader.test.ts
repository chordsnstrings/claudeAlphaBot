import { describe, expect, it, vi } from "vitest";

import type pg from "pg";

import {
  BinanceRestClient,
  type KlineParams,
  type ParsedKline,
} from "../../src/data/binance-rest.js";
import { loadHistoricalCandles } from "../../src/data/historical-loader.js";

const HOUR_MS = 3_600_000;

/**
 * Small in-memory pg.Pool shim. We only implement .query() with the
 * two SQL shapes used by the historical-loader:
 *   1. "SELECT MAX(open_time)::text AS max FROM candles WHERE symbol = $1"
 *   2. "INSERT INTO candles ... ON CONFLICT DO NOTHING"
 *   3. "WITH ordered AS (... LAG ...) SELECT COUNT(*)::text AS gaps ..."
 */
function makeFakePool(): { pool: pg.Pool; store: Map<string, ParsedKline> } {
  const store = new Map<string, ParsedKline>();

  const pool = {
    query: vi.fn(async (sql: string, values: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
      if (sql.includes("MAX(open_time)")) {
        const symbol = values[0] as string;
        let max: number | null = null;
        for (const [key, c] of store) {
          if (!key.startsWith(`${symbol}:`)) continue;
          if (max === null || c.openTime > max) max = c.openTime;
        }
        return { rows: [{ max: max === null ? null : String(max) }], rowCount: 1 };
      }
      if (sql.startsWith("\n    INSERT INTO candles")) {
        // values = [symbol, openTime, closeTime, open, high, low, close, volume] × N
        let inserted = 0;
        for (let i = 0; i < values.length; i += 8) {
          const symbol = values[i] as string;
          const openTime = values[i + 1] as number;
          const key = `${symbol}:${openTime}`;
          if (store.has(key)) continue;
          store.set(key, {
            symbol: symbol as ParsedKline["symbol"],
            openTime,
            closeTime: values[i + 2] as number,
            open: values[i + 3] as number,
            high: values[i + 4] as number,
            low: values[i + 5] as number,
            close: values[i + 6] as number,
            volume: values[i + 7] as number,
          });
          inserted += 1;
        }
        return { rows: [], rowCount: inserted };
      }
      if (sql.includes("WITH ordered AS")) {
        const symbol = values[0] as string;
        const from = values[1] as number;
        const to = values[2] as number;
        const ordered = [...store.values()]
          .filter((c) => c.symbol === symbol && c.openTime >= from && c.openTime <= to)
          .sort((a, b) => a.openTime - b.openTime);
        let gaps = 0;
        for (let i = 1; i < ordered.length; i++) {
          const curr = ordered[i];
          const prev = ordered[i - 1];
          if (curr && prev && curr.openTime - prev.openTime !== HOUR_MS) gaps += 1;
        }
        return { rows: [{ gaps: String(gaps) }], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  } as unknown as pg.Pool;

  return { pool, store };
}

function makeFakeClient(pages: ParsedKline[][]): BinanceRestClient {
  const client = new BinanceRestClient({ baseUrl: "https://example.invalid" });
  let call = 0;
  vi.spyOn(client, "getKlines").mockImplementation(async (_p: KlineParams) => {
    const page = pages[call] ?? [];
    call += 1;
    return page;
  });
  return client;
}

function genCandles(symbol: "BTCUSDT", startMs: number, count: number): ParsedKline[] {
  const out: ParsedKline[] = [];
  for (let i = 0; i < count; i++) {
    const openTime = startMs + i * HOUR_MS;
    out.push({
      symbol,
      openTime,
      closeTime: openTime + HOUR_MS - 1,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100.5 + i,
      volume: 1.23,
    });
  }
  return out;
}

describe("loadHistoricalCandles", () => {
  it("paginates + upserts; terminates when batch < PAGE_SIZE", async () => {
    const startMs = 1_700_000_000_000;
    const pageA = genCandles("BTCUSDT", startMs, 1000);
    const pageB = genCandles("BTCUSDT", startMs + 1000 * HOUR_MS, 50); // partial → stop

    const { pool, store } = makeFakePool();
    const client = makeFakeClient([pageA, pageB]);

    const result = await loadHistoricalCandles({
      symbol: "BTCUSDT",
      pool,
      client,
      startTime: startMs,
      endTime: startMs + 10_000 * HOUR_MS,
      paceMs: 0,
    });

    expect(result.fetched).toBe(1050);
    expect(result.inserted).toBe(1050);
    expect(result.pages).toBe(2);
    expect(result.firstOpenTime).toBe(startMs);
    expect(result.lastOpenTime).toBe(startMs + 1049 * HOUR_MS);
    expect(result.gapCount).toBe(0);
    expect(store.size).toBe(1050);
  });

  it("is idempotent — re-running does not insert duplicates", async () => {
    const startMs = 1_700_000_000_000;
    const page = genCandles("BTCUSDT", startMs, 100);
    const { pool, store } = makeFakePool();
    const client = makeFakeClient([page, []]);

    const first = await loadHistoricalCandles({
      symbol: "BTCUSDT",
      pool,
      client,
      startTime: startMs,
      endTime: startMs + 100 * HOUR_MS,
      paceMs: 0,
    });
    expect(first.inserted).toBe(100);
    expect(store.size).toBe(100);

    // Second run: same window, same cursor. Because max(open_time) is
    // already startMs+99h, the new cursor = that + 1h = endTime, so the
    // while loop terminates immediately → 0 pages fetched.
    const client2 = makeFakeClient([page]);
    const second = await loadHistoricalCandles({
      symbol: "BTCUSDT",
      pool,
      client: client2,
      startTime: startMs,
      endTime: startMs + 100 * HOUR_MS,
      paceMs: 0,
    });
    expect(second.inserted).toBe(0);
    expect(second.pages).toBe(0);
    expect(store.size).toBe(100);
  });

  it("detects a single gap in the sequence", async () => {
    const startMs = 1_700_000_000_000;
    // Generate 10 candles but skip index 5 to create one gap.
    const partial = genCandles("BTCUSDT", startMs, 10).filter((_, i) => i !== 5);
    const { pool } = makeFakePool();
    const client = makeFakeClient([partial]);
    const result = await loadHistoricalCandles({
      symbol: "BTCUSDT",
      pool,
      client,
      startTime: startMs,
      endTime: startMs + 10 * HOUR_MS,
      paceMs: 0,
    });
    expect(result.inserted).toBe(9);
    expect(result.gapCount).toBe(1);
  });
});
