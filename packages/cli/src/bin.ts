#!/usr/bin/env -S node --enable-source-maps
/** Commander dispatch for the @trading/cli package. */

import { Command } from "commander";

import { runBacktest } from "./backtest.js";
import { runIngestAsset } from "./ingest-asset.js";
import { runIngestFedRates } from "./ingest-fed-rates.js";
import { runIngestCrypto } from "./ingest-crypto.js";
import { runIngestFull } from "./ingest-full.js";
import { runIngestIncremental } from "./ingest-incremental.js";
import { runIngestReport } from "./ingest-report.js";
import { runWalkForwardCli } from "./research.js";

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

program
  .command("backtest")
  .description("Run a backtest of <strategy> on <instrument>/<timeframe> for [from..to]")
  .requiredOption("--strategy <name>", "registered strategy name (e.g. 'noop')")
  .requiredOption("--instrument <symbol>", "uppercase instrument code")
  .requiredOption("--timeframe <tf>", "m1 | m5 | h1 | d1")
  .requiredOption("--from <yyyy-mm-dd>", "inclusive start date")
  .requiredOption("--to <yyyy-mm-dd>", "inclusive end date")
  .action(
    async (opts: {
      strategy: string;
      instrument: string;
      timeframe: string;
      from: string;
      to: string;
    }) => {
      const tf = opts.timeframe.toLowerCase();
      if (tf !== "m1" && tf !== "m5" && tf !== "h1" && tf !== "d1") {
        process.exitCode = 2;
        return;
      }
      process.exitCode = await runBacktest({
        strategy: opts.strategy,
        instrument: opts.instrument,
        timeframe: tf,
        from: opts.from,
        to: opts.to,
      });
    },
  );

program
  .command("ingest:fed-rates")
  .description("Load the Federal Reserve H.10 daily exchange-rate series")
  .action(async () => {
    process.exitCode = await runIngestFedRates();
  });

program
  .command("ingest:crypto")
  .description("Load CoinMetrics daily crypto reference prices (BTC/ETH/…)")
  .action(async () => {
    process.exitCode = await runIngestCrypto();
  });

program
  .command("research:walkforward")
  .description("Run a walk-forward study of <strategy> across instruments")
  .requiredOption("--strategy <name>", "daily strategy (trend-following | donchian-breakout | bollinger-reversal)")
  .requiredOption("--instruments <list>", "comma-separated instrument codes")
  .requiredOption("--from <yyyy-mm-dd>", "overall start")
  .requiredOption("--to <yyyy-mm-dd>", "overall end")
  .option("--train-months <n>", "in-sample window length", "24")
  .option("--test-months <n>", "out-of-sample window length", "6")
  .option("--min-trades <n>", "min trades per window for inclusion", "10")
  .option("--params <json>", "strategy params override as JSON object")
  .option("--warmup-days <n>", "calendar days of pre-window warmup", "420")
  .option("--risk-per-trade <pct>", "sizing: fraction of equity risked per trade to its stop", "0.5")
  .option("--risk-config <json>", "RiskManager cap overrides as JSON (maxTotalOpenRiskPct, drawdownEmergencyStopPct, dailyLossLimitPct, …)")
  .option("--max-leverage <n>", "per-position notional leverage ceiling", "10")
  .action(
    async (opts: {
      strategy: string;
      instruments: string;
      from: string;
      to: string;
      trainMonths: string;
      testMonths: string;
      minTrades: string;
      params?: string;
      warmupDays: string;
      riskPerTrade: string;
      riskConfig?: string;
      maxLeverage: string;
    }) => {
      process.exitCode = await runWalkForwardCli({
        strategy: opts.strategy,
        instruments: opts.instruments,
        from: opts.from,
        to: opts.to,
        trainMonths: Number(opts.trainMonths),
        testMonths: Number(opts.testMonths),
        minTrades: Number(opts.minTrades),
        params:
          opts.params === undefined
            ? undefined
            : (JSON.parse(opts.params) as Record<string, number>),
        warmupDays: Number(opts.warmupDays),
        riskPerTradePct: Number(opts.riskPerTrade),
        riskConfig:
          opts.riskConfig === undefined
            ? undefined
            : (JSON.parse(opts.riskConfig) as Record<string, number>),
        maxLeverage: Number(opts.maxLeverage),
      });
    },
  );

await program.parseAsync(process.argv);
