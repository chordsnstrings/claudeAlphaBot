import { describe, expect, it, vi } from "vitest";

import type pg from "pg";

import {
  BinanceRestClient,
  type FundingRateParams,
  type ParsedFundingRate,
} from "../../src/data/binance-rest.js";
import { loadFundingRates } from "../../src/data/funding-loader.js";

const EIGHT_H = 8 * 60 * 60 * 1000;

function makeFakePool(): { pool: pg.Pool; store: Map<string, ParsedFundingRate> } {
  const store = new Map<string, ParsedFundingRate>();

  const pool = {
    query: vi.fn(async (sql: string, values: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
      if (sql.includes("MAX(funding_time)")) {
        const symbol = values[0] as string;
        let max: number | null = null;
        for (const [key, r] of store) {
          if (!key.startsWith(`${symbol}:`)) continue;
          if (max === null || r.fundingTime > max) max = r.fundingTime;
        }
        return { rows: [{ max: max === null ? null : String(max) }], rowCount: 1 };
      }
      if (sql.startsWith("\n    INSERT INTO funding_rates")) {
        let inserted = 0;
        for (let i = 0; i < values.length; i += 3) {
          const symbol = values[i] as string;
          const fundingTime = values[i + 1] as number;
          const key = `${symbol}:${fundingTime}`;
          if (store.has(key)) continue;
          store.set(key, {
            symbol: symbol as ParsedFundingRate["symbol"],
            fundingTime,
            fundingRate: values[i + 2] as number,
          });
          inserted += 1;
        }
        return { rows: [], rowCount: inserted };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  } as unknown as pg.Pool;

  return { pool, store };
}

function makeClient(pages: ParsedFundingRate[][]): BinanceRestClient {
  const client = new BinanceRestClient({ baseUrl: "https://example.invalid" });
  let call = 0;
  vi.spyOn(client, "getFundingRateHistory").mockImplementation(async (_p: FundingRateParams) => {
    const page = pages[call] ?? [];
    call += 1;
    return page;
  });
  return client;
}

function gen(startMs: number, count: number): ParsedFundingRate[] {
  const out: ParsedFundingRate[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      symbol: "BTCUSDT",
      fundingTime: startMs + i * EIGHT_H,
      fundingRate: 0.0001,
    });
  }
  return out;
}

describe("loadFundingRates", () => {
  it("paginates + upserts; terminates on short final page", async () => {
    const start = 1_700_000_000_000;
    const pageA = gen(start, 1000);
    const pageB = gen(start + 1000 * EIGHT_H, 50);

    const { pool, store } = makeFakePool();
    const client = makeClient([pageA, pageB]);

    const result = await loadFundingRates({
      symbol: "BTCUSDT",
      pool,
      client,
      startTime: start,
      endTime: start + 10_000 * EIGHT_H,
      paceMs: 0,
    });

    expect(result.fetched).toBe(1050);
    expect(result.inserted).toBe(1050);
    expect(result.pages).toBe(2);
    expect(store.size).toBe(1050);
  });

  it("resumes from stored max(funding_time) + 1ms", async () => {
    const start = 1_700_000_000_000;
    const page = gen(start, 10);
    const { pool, store } = makeFakePool();

    const client = makeClient([page, []]);
    const first = await loadFundingRates({
      symbol: "BTCUSDT",
      pool,
      client,
      startTime: start,
      endTime: start + 10 * EIGHT_H,
      paceMs: 0,
    });
    expect(first.inserted).toBe(10);
    expect(store.size).toBe(10);

    // Second run: cursor advances by +1ms (not +8h — funding times can
    // drift on special settlements). So the next call probes once and
    // returns duplicates which all hit ON CONFLICT → 0 inserted.
    const client2 = makeClient([page, []]);
    const second = await loadFundingRates({
      symbol: "BTCUSDT",
      pool,
      client: client2,
      startTime: start,
      endTime: start + 10 * EIGHT_H,
      paceMs: 0,
    });
    expect(second.inserted).toBe(0);
    expect(store.size).toBe(10);
  });
});
