/**
 * Validation pipeline tests. Inserts deliberately-crafted bars into a real
 * test DB and asserts the right `data_validation_issue` rows are produced.
 * No mocks; the spec forbids them.
 */

import { afterEach, describe, expect, it } from "vitest";

import { validateInstrumentTimeframe } from "../src/ingestion/validation.js";
import { buildRepos } from "../src/repos/index.js";
import type { NewBarRow } from "../src/schema/bar.js";
import { createTestDb, type TestDb } from "./helpers.js";

let tdb: TestDb | undefined;

afterEach(async () => {
  if (tdb !== undefined) {
    await tdb.cleanup();
    tdb = undefined;
  }
});

function mkBar(
  instrument: string,
  timeframe: NewBarRow["timeframe"],
  tsIso: string,
  o: number,
  h: number,
  l: number,
  c: number,
  v = 100,
): NewBarRow {
  return {
    instrument,
    timeframe,
    timestampUtc: new Date(tsIso),
    open: o.toFixed(6),
    high: h.toFixed(6),
    low: l.toFixed(6),
    close: c.toFixed(6),
    volume: v.toFixed(2),
    source: "historical",
  };
}

describe("validateInstrumentTimeframe", () => {
  it("reports no issues on clean continuous M1 data", async () => {
    tdb = await createTestDb("val_clean");
    const repos = buildRepos(tdb.db);
    // 30 minutes of clean EURUSD bars starting Monday 00:00 UTC
    const start = Date.parse("2025-11-03T00:00:00Z"); // Monday
    const rows: NewBarRow[] = [];
    for (let i = 0; i < 30; i += 1) {
      const ts = new Date(start + i * 60_000).toISOString();
      rows.push(mkBar("EURUSD", "m1", ts, 1.085, 1.0852, 1.0849, 1.0851));
    }
    await repos.bars.insertMany(rows);

    const summary = await validateInstrumentTimeframe(
      repos,
      "EURUSD",
      "m1",
      new Date("2025-11-03T00:00:00Z"),
      new Date("2025-11-03T01:00:00Z"),
    );
    expect(summary.totalBars).toBe(30);
    expect(summary.gaps).toBe(0);
    expect(summary.ohlcViolations).toBe(0);
    expect(summary.magnitudeIssues).toBe(0);
    expect(summary.zeroVolume).toBe(0);
  });

  it("detects an intra-week gap", async () => {
    tdb = await createTestDb("val_gap");
    const repos = buildRepos(tdb.db);
    const rows: NewBarRow[] = [
      mkBar("EURUSD", "m1", "2025-11-03T00:00:00Z", 1.085, 1.0852, 1.0849, 1.0851),
      mkBar("EURUSD", "m1", "2025-11-03T00:01:00Z", 1.0851, 1.0853, 1.0850, 1.0852),
      // 30-minute gap
      mkBar("EURUSD", "m1", "2025-11-03T00:31:00Z", 1.0852, 1.0855, 1.0851, 1.0854),
    ];
    await repos.bars.insertMany(rows);

    const summary = await validateInstrumentTimeframe(
      repos,
      "EURUSD",
      "m1",
      new Date("2025-11-03T00:00:00Z"),
      new Date("2025-11-03T01:00:00Z"),
    );
    expect(summary.gaps).toBe(1);
    expect(summary.issueIds.length).toBeGreaterThan(0);

    const issues = await repos.validation.findRecent("EURUSD", "m1");
    expect(issues.some((i) => i.issueType === "gap")).toBe(true);
  });

  it("flags magnitude when median close is wildly off", async () => {
    tdb = await createTestDb("val_mag");
    const repos = buildRepos(tdb.db);
    // EURUSD parsed as 1,180,000 instead of 1.18 — the canonical bug.
    const rows: NewBarRow[] = [];
    for (let i = 0; i < 5; i += 1) {
      const ts = new Date(Date.parse("2025-11-03T00:00:00Z") + i * 60_000).toISOString();
      rows.push(mkBar("EURUSD", "m1", ts, 1_180_000, 1_180_100, 1_179_900, 1_180_050));
    }
    await repos.bars.insertMany(rows);

    const summary = await validateInstrumentTimeframe(
      repos,
      "EURUSD",
      "m1",
      new Date("2025-11-03T00:00:00Z"),
      new Date("2025-11-03T01:00:00Z"),
    );
    expect(summary.magnitudeIssues).toBe(1);
    const issues = await repos.validation.findRecent("EURUSD", "m1");
    expect(issues.some((i) => i.issueType === "magnitude" && i.severity === "error")).toBe(true);
  });

  it("flags a long zero-volume run", async () => {
    tdb = await createTestDb("val_zerovol");
    const repos = buildRepos(tdb.db);
    const start = Date.parse("2025-11-03T00:00:00Z");
    const rows: NewBarRow[] = [];
    for (let i = 0; i < 10; i += 1) {
      const ts = new Date(start + i * 60_000).toISOString();
      // 6 zero-volume bars in the middle of the window
      const v = i >= 2 && i <= 7 ? 0 : 100;
      rows.push(mkBar("EURUSD", "m1", ts, 1.085, 1.0851, 1.0849, 1.0850, v));
    }
    await repos.bars.insertMany(rows);

    const summary = await validateInstrumentTimeframe(
      repos,
      "EURUSD",
      "m1",
      new Date("2025-11-03T00:00:00Z"),
      new Date("2025-11-03T01:00:00Z"),
    );
    expect(summary.zeroVolume).toBe(6);
    const issues = await repos.validation.findRecent("EURUSD", "m1");
    expect(issues.some((i) => i.issueType === "zero_volume_run")).toBe(true);
  });
});
