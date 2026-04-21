/**
 * Backfill CLI — fetch historical klines + funding rates and store in
 * the `candles` / `funding_rates` tables.
 *
 * Usage:
 *   tsx src/cli/backfill.ts [--months=3] [--symbols=BTCUSDT,ETHUSDT,SOLUSDT]
 *                           [--skip-funding] [--pace-ms=300]
 *
 * Idempotent: running again with more --months extends the history;
 * running with the same or smaller window is a no-op.
 */
import { loadEnv } from "../config/env.js";
import { closePool, getPool } from "../db/pool.js";
import { initLogger } from "../monitoring/logger.js";
import { binanceRestFromEnv } from "../data/binance-rest.js";
import { loadHistoricalCandles } from "../data/historical-loader.js";
import { loadFundingRates } from "../data/funding-loader.js";
import { SYMBOLS } from "@hydra/shared";
import type { Symbol as TradingSymbol } from "@hydra/shared";

interface Args {
  months: number;
  symbols: readonly TradingSymbol[];
  skipFunding: boolean;
  paceMs: number;
}

function parseArgs(argv: readonly string[]): Args {
  let months = 3;
  let symbols: readonly TradingSymbol[] = SYMBOLS;
  let skipFunding = false;
  let paceMs = 300;

  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg.startsWith("--months=")) {
      months = Number(arg.slice("--months=".length));
      if (!Number.isFinite(months) || months <= 0) throw new Error(`invalid --months: ${arg}`);
    } else if (arg.startsWith("--symbols=")) {
      const raw = arg.slice("--symbols=".length).split(",").map((s) => s.trim());
      const allowed = new Set<string>(SYMBOLS);
      for (const s of raw) {
        if (!allowed.has(s)) throw new Error(`invalid symbol ${s}; allowed: ${SYMBOLS.join(", ")}`);
      }
      symbols = raw as readonly TradingSymbol[];
    } else if (arg === "--skip-funding") {
      skipFunding = true;
    } else if (arg.startsWith("--pace-ms=")) {
      paceMs = Number(arg.slice("--pace-ms=".length));
      if (!Number.isFinite(paceMs) || paceMs < 0) throw new Error(`invalid --pace-ms: ${arg}`);
    } else {
      throw new Error(`unknown arg: ${arg}`);
    }
  }

  return { months, symbols, skipFunding, paceMs };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = initLogger({ level: env.LOG_LEVEL, format: env.LOG_FORMAT, nodeEnv: env.NODE_ENV });
  const args = parseArgs(process.argv.slice(2));
  logger.info({ ...args }, "backfill start");

  const pool = getPool();
  const client = binanceRestFromEnv(process.env);

  for (const symbol of args.symbols) {
    logger.info({ symbol }, "loading klines");
    const result = await loadHistoricalCandles({
      symbol,
      pool,
      client,
      months: args.months,
      paceMs: args.paceMs,
      onProgress: (p) => logger.debug(p, "page"),
    });
    logger.info(
      {
        symbol: result.symbol,
        fetched: result.fetched,
        inserted: result.inserted,
        pages: result.pages,
        firstOpenTime: result.firstOpenTime,
        lastOpenTime: result.lastOpenTime,
        gapCount: result.gapCount,
      },
      "klines complete",
    );

    if (!args.skipFunding) {
      logger.info({ symbol }, "loading funding rates");
      const fr = await loadFundingRates({
        symbol,
        pool,
        client,
        months: args.months,
        paceMs: args.paceMs,
      });
      logger.info({ symbol: fr.symbol, fetched: fr.fetched, inserted: fr.inserted, pages: fr.pages }, "funding complete");
    }
  }

  await closePool();
  logger.info("backfill done");
}

main().catch(async (err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("BACKFILL FAILED:", err);
  await closePool().catch(() => {});
  process.exit(1);
});
