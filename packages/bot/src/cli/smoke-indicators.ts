/**
 * Smoke: run every indicator on 100 consecutive candles loaded from
 * the `candles` table (most recent first) and print a summary. Used
 * as the Phase-5 "visual sanity check" — verifies no absurd values,
 * no NaN past the warmup, and that numeric ranges make sense.
 *
 * Usage:
 *   tsx src/cli/smoke-indicators.ts [--symbol=BTCUSDT] [--limit=100]
 */
import { loadEnv } from "../config/env.js";
import { closePool, getPool } from "../db/pool.js";
import { initLogger } from "../monitoring/logger.js";
import { atr, bollinger, adx, ema, rsi, percentile } from "../core/indicators.js";
import { SYMBOLS, type Symbol as TradingSymbol } from "@hydra/shared";

interface Args {
  symbol: TradingSymbol;
  limit: number;
}

function parseArgs(argv: readonly string[]): Args {
  let symbol: TradingSymbol = "BTCUSDT";
  let limit = 100;
  for (const a of argv) {
    if (a === "--") continue;
    if (a.startsWith("--symbol=")) {
      const v = a.slice("--symbol=".length);
      if (!(SYMBOLS as readonly string[]).includes(v)) throw new Error(`bad symbol: ${v}`);
      symbol = v as TradingSymbol;
    } else if (a.startsWith("--limit=")) {
      limit = Number(a.slice("--limit=".length));
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return { symbol, limit };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = initLogger({ level: env.LOG_LEVEL, format: env.LOG_FORMAT, nodeEnv: env.NODE_ENV });
  const args = parseArgs(process.argv.slice(2));

  const pool = getPool();
  const { rows } = await pool.query<{
    symbol: string;
    open_time: string;
    close_time: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
  }>(
    `SELECT symbol, open_time::text, close_time::text, open::text, high::text, low::text, close::text, volume::text
       FROM candles
      WHERE symbol = $1
      ORDER BY open_time DESC
      LIMIT $2`,
    [args.symbol, args.limit],
  );

  if (rows.length === 0) {
    logger.error(
      { symbol: args.symbol },
      "no candles found — run `pnpm --filter @hydra/bot backfill` first",
    );
    await closePool();
    process.exit(1);
  }

  // Reverse to oldest-first
  const candles = rows
    .map((r) => ({
      symbol: r.symbol as TradingSymbol,
      openTime: Number(r.open_time),
      closeTime: Number(r.close_time),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }))
    .reverse();

  const closes = candles.map((c) => c.close);

  const ema7 = ema(closes, 7);
  const ema25 = ema(closes, 25);
  const ema99 = ema(closes, 99);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(candles, 14);
  const bb = bollinger(closes, 14, 2);
  const { plusDI, minusDI, adx: adx14 } = adx(candles, 14);

  const last = candles.length - 1;
  const lastClose = closes[last]!;
  const atrPctLast = lastClose && Number.isFinite(atr14[last]!) ? (atr14[last]! / lastClose) * 100 : NaN;
  const bbWidthPctile = percentile(bb.bandwidth.filter((v) => Number.isFinite(v)), 50);

  logger.info(
    {
      symbol: args.symbol,
      candleCount: candles.length,
      firstOpenTime: candles[0]?.openTime,
      lastOpenTime: candles[last]?.openTime,
      lastClose,
      ema7Last: ema7[last],
      ema25Last: ema25[last],
      ema99Last: ema99[last],
      rsi14Last: rsi14[last],
      atr14Last: atr14[last],
      atrPctOfClose: atrPctLast,
      bbMiddleLast: bb.middle[last],
      bbUpperLast: bb.upper[last],
      bbLowerLast: bb.lower[last],
      bbWidthLast: bb.bandwidth[last],
      bbWidthMedian: bbWidthPctile,
      plusDILast: plusDI[last],
      minusDILast: minusDI[last],
      adx14Last: adx14[last],
    },
    "indicators smoke complete",
  );

  await closePool();
}

main().catch(async (err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("SMOKE FAILED:", err);
  await closePool().catch(() => {});
  process.exit(1);
});
