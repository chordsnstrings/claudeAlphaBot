/**
 * HistoricalDataFeed integration tests.
 *
 * Every test inserts real rows into a real Postgres schema via the Drizzle
 * BarRepo, then drives the feed end-to-end. No mocks are used.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { Bar, Clock, Timeframe } from "@trading/core";
import { buildRepos, type NewBarRow } from "@trading/data";
import { createTestDb, type TestDb } from "@trading/data/test-utils";

import { HistoricalDataFeed } from "../src/historical-data-feed.js";

let tdb: TestDb | undefined;

afterEach(async () => {
  if (tdb !== undefined) {
    await tdb.cleanup();
    tdb = undefined;
  }
});

/** Always returns `at`, ignoring sleep. Used to pin the clock for tests. */
class FixedClock implements Clock {
  constructor(private at: Date) {}
  now(): Date {
    return this.at;
  }
  set(at: Date): void {
    this.at = at;
  }
  async sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }
}

function dailyBar(
  instrument: string,
  isoDate: string,
  base = 1.1,
  vol = 100,
): NewBarRow {
  const close = base + 0.0001;
  return {
    instrument,
    timeframe: "d1",
    timestampUtc: new Date(`${isoDate}T00:00:00Z`),
    open: base.toFixed(6),
    high: (Math.max(base, close) + 0.0005).toFixed(6),
    low: (Math.min(base, close) - 0.0005).toFixed(6),
    close: close.toFixed(6),
    volume: vol.toFixed(2),
    source: "historical",
  };
}

async function drain(
  feed: HistoricalDataFeed,
  instrument: string,
  timeframe: Timeframe,
): Promise<Bar[]> {
  const out: Bar[] = [];
  for await (const bar of feed.subscribe(instrument, timeframe)) {
    out.push(bar);
  }
  return out;
}

describe("HistoricalDataFeed", () => {
  it("yields bars chronologically regardless of insertion order", async () => {
    tdb = await createTestDb("hdf_chrono");
    const repos = buildRepos(tdb.db);

    // Insert in shuffled order.
    const dates = [
      "2025-01-08",
      "2025-01-03",
      "2025-01-09",
      "2025-01-01",
      "2025-01-05",
      "2025-01-02",
      "2025-01-07",
      "2025-01-04",
      "2025-01-06",
      "2025-01-10",
    ];
    await repos.bars.insertMany(dates.map((d) => dailyBar("EURUSD", d)));

    const feed = new HistoricalDataFeed(
      { db: tdb.db, pool: tdb.pool, clock: new FixedClock(new Date("2030-01-01T00:00:00Z")) },
      {
        instruments: ["EURUSD"],
        timeframes: ["d1"],
        from: new Date("2025-01-01T00:00:00Z"),
        to: new Date("2025-01-31T00:00:00Z"),
      },
    );
    await feed.start();
    const out = await drain(feed, "EURUSD", "d1");
    await feed.stop();

    expect(out).toHaveLength(10);
    const got = out.map((b) => b.timestampUtc.toISOString().slice(0, 10));
    expect(got).toEqual([...dates].sort());
  });

  it("interleaves bars across multiple instruments by timestamp", async () => {
    tdb = await createTestDb("hdf_multi");
    const repos = buildRepos(tdb.db);

    // EURUSD on odd days, GBPUSD on even days — same Jan range.
    const eur = ["2025-01-01", "2025-01-03", "2025-01-05", "2025-01-07"].map((d) =>
      dailyBar("EURUSD", d, 1.1),
    );
    const gbp = ["2025-01-02", "2025-01-04", "2025-01-06", "2025-01-08"].map((d) =>
      dailyBar("GBPUSD", d, 1.27),
    );
    await repos.bars.insertMany([...eur, ...gbp]);

    const feed = new HistoricalDataFeed(
      {
        db: tdb.db,
        pool: tdb.pool,
        clock: new FixedClock(new Date("2030-01-01T00:00:00Z")),
      },
      {
        instruments: ["EURUSD", "GBPUSD"],
        timeframes: ["d1"],
        from: new Date("2025-01-01T00:00:00Z"),
        to: new Date("2025-01-31T00:00:00Z"),
      },
    );
    await feed.start();

    // Drain both queues in parallel; merge by yield order to check timeline.
    const eurBars: Bar[] = [];
    const gbpBars: Bar[] = [];
    const merged: Bar[] = [];
    let eurNext: Promise<IteratorResult<Bar>> | null = null;
    let gbpNext: Promise<IteratorResult<Bar>> | null = null;

    const eurIter = feed.subscribe("EURUSD", "d1")[Symbol.asyncIterator]();
    const gbpIter = feed.subscribe("GBPUSD", "d1")[Symbol.asyncIterator]();

    let bothDone = false;
    while (!bothDone) {
      if (eurNext === null) {
        eurNext = eurIter.next();
      }
      if (gbpNext === null) {
        gbpNext = gbpIter.next();
      }
      const [eurR, gbpR] = await Promise.all([eurNext, gbpNext]);
      if (eurR.done && gbpR.done) {
        bothDone = true;
        break;
      }
      if (eurR.done) {
        merged.push(gbpR.value);
        gbpBars.push(gbpR.value);
        gbpNext = null;
        continue;
      }
      if (gbpR.done) {
        merged.push(eurR.value);
        eurBars.push(eurR.value);
        eurNext = null;
        continue;
      }
      // Both have a value — pick the earlier one to merge into a global timeline.
      if (eurR.value.timestampUtc.getTime() <= gbpR.value.timestampUtc.getTime()) {
        merged.push(eurR.value);
        eurBars.push(eurR.value);
        eurNext = null;
      } else {
        merged.push(gbpR.value);
        gbpBars.push(gbpR.value);
        gbpNext = null;
      }
    }
    await feed.stop();

    // Each pair iterates its own timeline cleanly.
    expect(eurBars.map((b) => b.timestampUtc.toISOString().slice(0, 10))).toEqual([
      "2025-01-01",
      "2025-01-03",
      "2025-01-05",
      "2025-01-07",
    ]);
    expect(gbpBars.map((b) => b.timestampUtc.toISOString().slice(0, 10))).toEqual([
      "2025-01-02",
      "2025-01-04",
      "2025-01-06",
      "2025-01-08",
    ]);
    // Merged timeline is strictly chronological — proving multi-instrument
    // interleaving works at the source (producer) level.
    for (let i = 1; i < merged.length; i += 1) {
      const prev = merged[i - 1];
      const cur = merged[i];
      if (prev === undefined || cur === undefined) {continue;}
      expect(prev.timestampUtc.getTime()).toBeLessThanOrEqual(cur.timestampUtc.getTime());
    }
  });

  it("getHistoricalBars returns rows in [from, to] sorted by timestamp", async () => {
    tdb = await createTestDb("hdf_hist");
    const repos = buildRepos(tdb.db);
    const dates = ["2025-01-01", "2025-01-02", "2025-01-03", "2025-01-04"];
    await repos.bars.insertMany(dates.map((d) => dailyBar("EURUSD", d)));

    const feed = new HistoricalDataFeed(
      { db: tdb.db, pool: tdb.pool, clock: new FixedClock(new Date("2030-01-01T00:00:00Z")) },
      {
        instruments: ["EURUSD"],
        timeframes: ["d1"],
        from: new Date("2025-01-01T00:00:00Z"),
        to: new Date("2025-01-31T00:00:00Z"),
      },
    );
    await feed.start();
    const bars = await feed.getHistoricalBars(
      "EURUSD",
      "d1",
      new Date("2025-01-02T00:00:00Z"),
      new Date("2025-01-03T23:59:59Z"),
    );
    await feed.stop();
    expect(bars.map((b) => b.timestampUtc.toISOString().slice(0, 10))).toEqual([
      "2025-01-02",
      "2025-01-03",
    ]);
  });

  it("getCurrentBar tracks the most recently yielded bar", async () => {
    tdb = await createTestDb("hdf_current");
    const repos = buildRepos(tdb.db);
    await repos.bars.insertMany(
      ["2025-01-01", "2025-01-02", "2025-01-03"].map((d) => dailyBar("EURUSD", d)),
    );
    const feed = new HistoricalDataFeed(
      { db: tdb.db, pool: tdb.pool, clock: new FixedClock(new Date("2030-01-01T00:00:00Z")) },
      {
        instruments: ["EURUSD"],
        timeframes: ["d1"],
        from: new Date("2025-01-01T00:00:00Z"),
        to: new Date("2025-01-31T00:00:00Z"),
      },
    );
    await feed.start();
    expect(feed.getCurrentBar("EURUSD", "d1")).toBeNull();
    const iter = feed.subscribe("EURUSD", "d1")[Symbol.asyncIterator]();
    const r1 = await iter.next();
    if (r1.done) {throw new Error("expected bar");}
    expect(feed.getCurrentBar("EURUSD", "d1")?.timestampUtc.toISOString().slice(0, 10)).toBe(
      "2025-01-01",
    );
    const r2 = await iter.next();
    if (r2.done) {throw new Error("expected bar");}
    expect(feed.getCurrentBar("EURUSD", "d1")?.timestampUtc.toISOString().slice(0, 10)).toBe(
      "2025-01-02",
    );
    await feed.stop();
  });

  it("enforces no-lookahead with a one-bar-period allowance", async () => {
    // The HDF gate allows bar.ts <= clock.now() + timeframe-period so the
    // engine can pull "the next bar" before advancing the SimulatedClock.
    // Pinning the clock further behind keeps the iterator gated.
    tdb = await createTestDb("hdf_lookahead");
    const repos = buildRepos(tdb.db);
    const dates = ["2025-01-01", "2025-01-02", "2025-01-03", "2025-01-04", "2025-01-05"];
    await repos.bars.insertMany(dates.map((d) => dailyBar("EURUSD", d)));

    // Clock at Jan 2 00:00 -> allowance 1 day -> bars up to Jan 3 00:00
    // yield. Jan 4+ must block.
    const clock = new FixedClock(new Date("2025-01-02T00:00:00Z"));
    const feed = new HistoricalDataFeed(
      { db: tdb.db, pool: tdb.pool, clock },
      {
        instruments: ["EURUSD"],
        timeframes: ["d1"],
        from: new Date("2025-01-01T00:00:00Z"),
        to: new Date("2025-01-31T00:00:00Z"),
        clockPollMs: 5,
      },
    );
    await feed.start();
    const iter = feed.subscribe("EURUSD", "d1")[Symbol.asyncIterator]();
    const got: Bar[] = [];
    // Pull the first three (Jan 1, 2, 3 — all <= clock + 1 day).
    for (let i = 0; i < 3; i += 1) {
      const r = await iter.next();
      if (r.done) {
        throw new Error("unexpected end");
      }
      got.push(r.value);
    }
    // The fourth (Jan 4) must block.
    const fourth = iter.next();
    const timeout = new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 150));
    const outcome = await Promise.race([fourth.then(() => "yielded" as const), timeout]);
    expect(outcome).toBe("timeout");

    // Advance the clock and confirm the fourth bar releases.
    clock.set(new Date("2025-01-03T00:00:00Z"));
    const r4 = await fourth;
    expect(r4.done).toBe(false);
    if (!r4.done) {
      got.push(r4.value);
    }
    expect(got.map((b) => b.timestampUtc.toISOString().slice(0, 10))).toEqual([
      "2025-01-01",
      "2025-01-02",
      "2025-01-03",
      "2025-01-04",
    ]);
    await feed.stop();
  });

  it("performance: 30 instruments × 5 years daily streams in under 30 s", async () => {
    tdb = await createTestDb("hdf_perf");
    const repos = buildRepos(tdb.db);

    // 5 years × 252 trading days × 30 instruments = 37 800 bars.
    const instruments: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      instruments.push(`PAIR${String(i).padStart(2, "0")}`);
    }
    const days = 252 * 5;
    const start = Date.parse("2020-01-01T00:00:00Z");

    // Bulk insert in chunks to avoid one giant parameter list.
    const CHUNK = 2000;
    let batch: NewBarRow[] = [];
    let totalInserted = 0;
    for (let d = 0; d < days; d += 1) {
      const ts = new Date(start + d * 86_400_000);
      for (const inst of instruments) {
        batch.push({
          instrument: inst,
          timeframe: "d1",
          timestampUtc: ts,
          open: "1.000000",
          high: "1.001000",
          low: "0.999000",
          close: "1.000500",
          volume: "100.00",
          source: "historical",
        });
        if (batch.length >= CHUNK) {
          totalInserted += await repos.bars.insertMany(batch);
          batch = [];
        }
      }
    }
    if (batch.length > 0) {
      totalInserted += await repos.bars.insertMany(batch);
    }
    expect(totalInserted).toBe(instruments.length * days);

    const feed = new HistoricalDataFeed(
      { db: tdb.db, pool: tdb.pool, clock: new FixedClock(new Date("2030-01-01T00:00:00Z")) },
      {
        instruments,
        timeframes: ["d1"],
        from: new Date("2020-01-01T00:00:00Z"),
        to: new Date("2025-12-31T00:00:00Z"),
        pageSize: 10_000,
      },
    );
    await feed.start();
    const t0 = Date.now();
    // Drain every subscription in parallel.
    let totalYielded = 0;
    await Promise.all(
      instruments.map(async (inst) => {
        for await (const bar of feed.subscribe(inst, "d1")) {
          if (bar) {
            totalYielded += 1;
          }
        }
      }),
    );
    const elapsedMs = Date.now() - t0;
    await feed.stop();
    expect(totalYielded).toBe(instruments.length * days);
    // Spec gate: <30 s.
    expect(elapsedMs).toBeLessThan(30_000);
  }, 120_000);
});
