/**
 * High-level ingest() tests. The actual Dukascopy network fetch is not
 * exercised here (it varies by host); we cover the unavailable-instrument
 * fast path which doesn't need the network. The integration smoke for the
 * fetch path runs as `pnpm ingest:asset` on a network-capable host.
 */

import { afterEach, describe, expect, it } from "vitest";

import { ingest } from "../src/ingestion/ingest.js";
import { buildRepos } from "../src/repos/index.js";
import { createTestDb, type TestDb } from "./helpers.js";

let tdb: TestDb | undefined;

afterEach(async () => {
  if (tdb !== undefined) {
    await tdb.cleanup();
    tdb = undefined;
  }
});

describe("ingest()", () => {
  it("records an unavailable-instrument issue and returns skipped status", async () => {
    tdb = await createTestDb("ingest_unavail");
    const repos = buildRepos(tdb.db);
    const result = await ingest(repos, {
      instrument: "ZZZZZZ",
      timeframe: "d1",
      from: new Date("2025-01-01T00:00:00Z"),
      to: new Date("2025-01-02T00:00:00Z"),
    });
    expect(result.status).toBe("skipped_unavailable");
    expect(result.fetched).toBe(0);
    expect(result.inserted).toBe(0);

    const issues = await repos.validation.findRecent("ZZZZZZ", "d1");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.issueType).toBe("unavailable_instrument");
  });
});
