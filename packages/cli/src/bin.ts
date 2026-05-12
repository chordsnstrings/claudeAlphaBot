#!/usr/bin/env -S node --enable-source-maps
/** Commander dispatch for the @trading/cli package. */

import { Command } from "commander";

import { runIngestAsset } from "./ingest-asset.js";
import { runIngestFull } from "./ingest-full.js";
import { runIngestIncremental } from "./ingest-incremental.js";
import { runIngestReport } from "./ingest-report.js";

const program = new Command();
program
  .name("trading-cli")
  .description("Operational CLI for the trading system")
  .version("0.1.0");

program
  .command("ingest:full")
  .description("Ingest the default daily + M1 universe per spec section 14")
  .action(async () => {
    process.exitCode = await runIngestFull();
  });

program
  .command("ingest:asset")
  .description("Ingest one instrument/timeframe/range")
  .requiredOption("--instrument <symbol>", "uppercase instrument code (e.g. EURUSD)")
  .requiredOption("--timeframe <tf>", "m1 | m5 | h1 | d1")
  .requiredOption("--from <yyyy-mm-dd>", "inclusive start date")
  .requiredOption("--to <yyyy-mm-dd>", "inclusive end date")
  .action(async (opts: { instrument: string; timeframe: string; from: string; to: string }) => {
    const tf = opts.timeframe.toLowerCase();
    if (tf !== "m1" && tf !== "m5" && tf !== "h1" && tf !== "d1") {
      process.exitCode = 2;
      return;
    }
    process.exitCode = await runIngestAsset({
      instrument: opts.instrument,
      timeframe: tf,
      from: opts.from,
      to: opts.to,
    });
  });

program
  .command("ingest:incremental")
  .description("Update each pair from its latest bar to --to (default: now)")
  .option("--to <yyyy-mm-dd>", "exclusive end boundary; default = now (UTC)")
  .option("--timeframes <list>", "comma-separated tf list", "d1,m1")
  .action(async (opts: { to?: string; timeframes: string }) => {
    const tfs = opts.timeframes
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is "m1" | "m5" | "h1" | "d1" =>
        s === "m1" || s === "m5" || s === "h1" || s === "d1",
      );
    const callOpts: { to?: string; timeframes?: typeof tfs } = { timeframes: tfs };
    if (opts.to !== undefined) {
      callOpts.to = opts.to;
    }
    process.exitCode = await runIngestIncremental(callOpts);
  });

program
  .command("ingest:report")
  .description("Print row counts + first/last bar per (instrument, timeframe)")
  .action(async () => {
    process.exitCode = await runIngestReport();
  });

await program.parseAsync(process.argv);
