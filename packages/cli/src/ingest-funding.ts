/**
 * `ingest:funding --file <path> [--interval 8h|1d]` — load a perp funding-rate
 * CSV (date,asset,funding_rate) into synthetic `<ASSET>CARRY` instruments so
 * the cash-and-carry / funding-harvest strategy can be backtested.
 *
 * No funding data ships with the repo; supply your own export.
 */

import { readFile } from "node:fs/promises";

import { logger } from "@trading/core";
import { ingestFunding, parseFundingCsv, buildCarryBars } from "@trading/data";

import { buildContext } from "./context.js";

const log = logger("cli.ingest-funding");

export async function runIngestFunding(opts: { file: string; interval: string }): Promise<number> {
  const raw = await readFile(opts.file, "utf8");
  // If the source is per-8h funding, three intervals make a day; convert to a
  // daily compounded figure so buildCarryBars' daily compounding is correct.
  let csvText = raw;
  if (opts.interval === "8h") {
    const rows = parseFundingCsv(raw);
    const byKey = new Map<string, number>();
    for (const r of rows) {
      const k = `${r.date}|${r.asset}`;
      // Compound the (up to three) 8h rates within a day.
      byKey.set(k, (1 + (byKey.get(k) ?? 0)) * (1 + r.fundingRate) - 1);
    }
    const lines = ["date,asset,funding_rate"];
    for (const [k, v] of byKey.entries()) {
      const [date, asset] = k.split("|");
      lines.push(`${date},${asset},${v}`);
    }
    csvText = lines.join("\n");
    // buildCarryBars is re-exported only to keep this conversion path honest in
    // tests; not used directly here.
    void buildCarryBars;
  }
  const ctx = buildContext();
  try {
    const result = await ingestFunding(ctx.repos, { csvText });
    log.info(
      {
        instruments: result.instrumentsLoaded,
        barsByInstrument: result.barsByInstrument,
        total: result.totalBars,
      },
      "funding ingest complete",
    );
    return 0;
  } finally {
    await ctx.close();
  }
}
