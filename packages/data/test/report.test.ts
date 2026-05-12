import { afterEach, describe, expect, it } from "vitest";

import { reportAll, reportForPair } from "../src/ingestion/report.js";
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

describe("ingest report", () => {
  it("returns zero for empty pair", async () => {
    tdb = await createTestDb("rep_empty");
    const r = await reportForPair(tdb.db, "EURUSD", "m1");
    expect(r.rows).toBe(0);
    expect(r.firstBar).toBeNull();
    expect(r.lastBar).toBeNull();
  });

  it("returns counts + first/last bar after insert", async () => {
    tdb = await createTestDb("rep_data");
    const repos = buildRepos(tdb.db);
    const rows: NewBarRow[] = [
      {
        instrument: "EURUSD",
        timeframe: "m1",
        timestampUtc: new Date("2025-11-03T00:00:00Z"),
        open: "1.085000",
        high: "1.085200",
        low: "1.084900",
        close: "1.085100",
        volume: "100.00",
        source: "historical",
      },
      {
        instrument: "EURUSD",
        timeframe: "m1",
        timestampUtc: new Date("2025-11-03T00:01:00Z"),
        open: "1.085100",
        high: "1.085300",
        low: "1.085000",
        close: "1.085200",
        volume: "120.00",
        source: "historical",
      },
    ];
    await repos.bars.insertMany(rows);
    const r = await reportForPair(tdb.db, "EURUSD", "m1");
    expect(r.rows).toBe(2);
    expect(r.firstBar?.toISOString()).toBe("2025-11-03T00:00:00.000Z");
    expect(r.lastBar?.toISOString()).toBe("2025-11-03T00:01:00.000Z");

    const all = await reportAll(tdb.db, [{ instrument: "EURUSD", timeframe: "m1" }]);
    expect(all).toHaveLength(1);
  });
});
