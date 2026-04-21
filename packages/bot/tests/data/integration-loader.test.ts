/**
 * End-to-end integration test: stands up a local HTTP server that
 * mimics Binance's /fapi/v1/klines + /fapi/v1/fundingRate shape and
 * runs the REAL REST client + REAL loader against it, writing into
 * the REAL postgres `candles` + `funding_rates` tables.
 *
 * Runs only when HYDRA_INTEGRATION_DB is set. Requires migrations
 * already applied.
 */
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import pg from "pg";

import { BinanceRestClient } from "../../src/data/binance-rest.js";
import { loadHistoricalCandles } from "../../src/data/historical-loader.js";
import { loadFundingRates } from "../../src/data/funding-loader.js";

const skip = !process.env["HYDRA_INTEGRATION_DB"];

const HOUR_MS = 3_600_000;
const EIGHT_H = 8 * HOUR_MS;

function buildKline(openTime: number): [number, string, string, string, string, string, number, string, number, string, string, string] {
  return [
    openTime,
    "25000.00",
    "25100.00",
    "24900.00",
    "25050.00",
    "100.5",
    openTime + HOUR_MS - 1,
    "2500000",
    42,
    "50",
    "1250000",
    "0",
  ];
}

function buildFunding(t: number, rate: string) {
  return { symbol: "BTCUSDT", fundingTime: t, fundingRate: rate };
}

describe.skipIf(skip)("integration: loaders + postgres via local fake Binance", () => {
  let server: Server;
  let baseUrl: string;
  let pool: pg.Pool;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "", "http://x");
      if (url.pathname === "/fapi/v1/klines") {
        const startTime = Number(url.searchParams.get("startTime"));
        const endTime = Number(url.searchParams.get("endTime"));
        const limit = Number(url.searchParams.get("limit") ?? "1000");
        const rows: unknown[] = [];
        for (let t = startTime; t < endTime && rows.length < limit; t += HOUR_MS) {
          rows.push(buildKline(t));
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(rows));
        return;
      }
      if (url.pathname === "/fapi/v1/fundingRate") {
        const startTime = Number(url.searchParams.get("startTime"));
        const endTime = Number(url.searchParams.get("endTime"));
        const limit = Number(url.searchParams.get("limit") ?? "1000");
        const rows: unknown[] = [];
        for (let t = ceilTo(startTime, EIGHT_H); t < endTime && rows.length < limit; t += EIGHT_H) {
          rows.push(buildFunding(t, "0.00010000"));
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(rows));
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
    // Isolate: clear only BTCUSDT test rows we're about to insert.
    // Use a fixed fake window in the deep past so we never collide
    // with real backfills.
    await pool.query("DELETE FROM candles WHERE symbol = 'BTCUSDT' AND open_time < 100000000");
    await pool.query("DELETE FROM funding_rates WHERE symbol = 'BTCUSDT' AND funding_time < 100000000");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM candles WHERE symbol = 'BTCUSDT' AND open_time < 100000000");
    await pool.query("DELETE FROM funding_rates WHERE symbol = 'BTCUSDT' AND funding_time < 100000000");
    await pool.end();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("loads klines → writes to postgres → matches schema + CHECK constraints", async () => {
    const client = new BinanceRestClient({ baseUrl, minTimeoutMs: 1, maxTimeoutMs: 5 });
    // Choose a window in the distant past so it doesn't conflict with
    // real production data. 2090 epoch would be future; we want past:
    const windowStart = 1_000_000; // ms
    const windowEnd = windowStart + 100 * HOUR_MS;

    const result = await loadHistoricalCandles({
      symbol: "BTCUSDT",
      pool,
      client,
      startTime: windowStart,
      endTime: windowEnd,
      paceMs: 0,
    });

    expect(result.fetched).toBe(100);
    expect(result.inserted).toBe(100);
    expect(result.gapCount).toBe(0);

    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM candles WHERE symbol='BTCUSDT' AND open_time >= $1 AND open_time < $2",
      [windowStart, windowEnd],
    );
    expect(Number(rows[0]?.count)).toBe(100);
  });

  it("is idempotent on re-run (ON CONFLICT DO NOTHING)", async () => {
    const client = new BinanceRestClient({ baseUrl, minTimeoutMs: 1, maxTimeoutMs: 5 });
    const windowStart = 1_000_000;
    const windowEnd = windowStart + 100 * HOUR_MS;

    const result = await loadHistoricalCandles({
      symbol: "BTCUSDT",
      pool,
      client,
      startTime: windowStart,
      endTime: windowEnd,
      paceMs: 0,
    });
    // Loader resumes from MAX(open_time)+1h — which is ≥ endTime, so
    // zero pages fetched.
    expect(result.pages).toBe(0);
    expect(result.inserted).toBe(0);
  });

  it("loads funding rates with NUMERIC precision preserved", async () => {
    const client = new BinanceRestClient({ baseUrl, minTimeoutMs: 1, maxTimeoutMs: 5 });
    const windowStart = 1_000_000;
    const windowEnd = windowStart + 100 * EIGHT_H;

    const result = await loadFundingRates({
      symbol: "BTCUSDT",
      pool,
      client,
      startTime: windowStart,
      endTime: windowEnd,
      paceMs: 0,
    });
    expect(result.inserted).toBeGreaterThanOrEqual(99);
    const { rows } = await pool.query<{ rate: string }>(
      "SELECT funding_rate::text AS rate FROM funding_rates WHERE symbol='BTCUSDT' AND funding_time >= $1 AND funding_time < $2 LIMIT 1",
      [windowStart, windowEnd],
    );
    expect(Number(rows[0]?.rate)).toBeCloseTo(0.0001, 8);
  });
});

function ceilTo(n: number, step: number): number {
  return Math.ceil(n / step) * step;
}
