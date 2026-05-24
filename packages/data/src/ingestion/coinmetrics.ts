/**
 * CoinMetrics community network-data ingestion (daily crypto reference prices).
 *
 * Source: https://raw.githubusercontent.com/coinmetrics/data/master/csv/<asset>.csv
 * Each asset CSV is wide (network metrics) with a daily `time` column and a
 * `PriceUSD` column (the CoinMetrics reference rate). We take date + PriceUSD
 * and build O=H=L=C daily bars — close-only, exactly like the Fed FX series, so
 * the same fidelity caveat applies: close-to-close strategies (momentum,
 * breakout-on-close) are trustworthy; tight-stop strategies are not (no
 * intrabar high/low).
 *
 * Instrument codes use the USDT-margined perp convention (BTCUSDT, ETHUSDT …)
 * so sizing/friction branch to crypto contract rules (1 lot = 1 coin, %-of-
 * notional fees, daily funding). The underlying is a spot reference rate; we
 * model it as the perp underlying and charge funding separately (see
 * cryptoFundingDailyBps). Basis/term-structure is not modelled.
 */

import { logger, type Timeframe } from "@trading/core";
import type { NewBarRow, Repos } from "@trading/data";

const log = logger("data.coinmetrics");

export const COINMETRICS_BASE_URL =
  "https://raw.githubusercontent.com/coinmetrics/data/master/csv";

/** CoinMetrics asset slug -> instrument code. */
export const DEFAULT_CRYPTO_ASSETS: Record<string, string> = {
  btc: "BTCUSDT",
  eth: "ETHUSDT",
  ltc: "LTCUSDT",
  xrp: "XRPUSDT",
  doge: "DOGEUSDT",
  bnb: "BNBUSDT",
  ada: "ADAUSDT",
  // NB: sol/avax/etc. lack a PriceUSD column in the CoinMetrics community
  // tier, so they're excluded — only assets with a reference price are usable.
};

export interface CryptoIngestResult {
  instrumentsLoaded: string[];
  barsByInstrument: Record<string, number>;
  totalBars: number;
}

interface ParsedBar {
  date: string; // YYYY-MM-DD
  price: number;
}

/**
 * Parse one CoinMetrics asset CSV, extracting (date, PriceUSD) for rows that
 * have a finite positive price. Column positions vary per asset, so PriceUSD
 * is located by header name.
 */
export function parseCoinMetricsCsv(csv: string): ParsedBar[] {
  const lines = csv.split("\n");
  const header = lines[0];
  if (header === undefined) {
    return [];
  }
  const cols = header.split(",");
  const timeIdx = cols.indexOf("time");
  const priceIdx = cols.indexOf("PriceUSD");
  if (timeIdx < 0 || priceIdx < 0) {
    return [];
  }
  const out: ParsedBar[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.length === 0) {
      continue;
    }
    const fields = line.split(",");
    const timeRaw = fields[timeIdx];
    const priceRaw = fields[priceIdx];
    if (timeRaw === undefined || priceRaw === undefined || priceRaw === "") {
      continue;
    }
    const price = Number(priceRaw);
    if (!Number.isFinite(price) || price <= 0) {
      continue;
    }
    // `time` may be a date or a full ISO timestamp; keep the date part.
    const date = timeRaw.slice(0, 10);
    out.push({ date, price });
  }
  return out;
}

/** Build daily OHLC bars (O=H=L=C=price) for one instrument's series. */
export function cryptoToDailyBars(instrument: string, rows: ParsedBar[]): NewBarRow[] {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : 1));
  return sorted.map((r) => {
    const px = r.price.toFixed(8);
    return {
      instrument,
      timeframe: "d1" as Timeframe,
      timestampUtc: new Date(`${r.date}T00:00:00Z`),
      open: px,
      high: px,
      low: px,
      close: px,
      volume: "0",
      source: "historical",
    } satisfies NewBarRow;
  });
}

/** Fetch + parse + ingest the configured crypto assets. Idempotent. */
export async function ingestCoinMetrics(
  repos: Repos,
  opts: { assets?: Record<string, string>; baseUrl?: string; csvByAsset?: Record<string, string> } = {},
): Promise<CryptoIngestResult> {
  const assets = opts.assets ?? DEFAULT_CRYPTO_ASSETS;
  const baseUrl = opts.baseUrl ?? COINMETRICS_BASE_URL;
  const barsByInstrument: Record<string, number> = {};
  let total = 0;
  for (const [slug, instrument] of Object.entries(assets)) {
    let csv = opts.csvByAsset?.[slug];
    if (csv === undefined) {
      const url = `${baseUrl}/${slug}.csv`;
      log.info({ url, instrument }, "fetching CoinMetrics asset");
      const res = await fetch(url);
      if (!res.ok) {
        log.warn({ slug, status: res.status }, "coinmetrics fetch failed; skipping");
        continue;
      }
      csv = await res.text();
    }
    const rows = parseCoinMetricsCsv(csv);
    const bars = cryptoToDailyBars(instrument, rows);
    let inserted = 0;
    const CHUNK = 2000;
    for (let i = 0; i < bars.length; i += CHUNK) {
      inserted += await repos.bars.insertMany(bars.slice(i, i + CHUNK));
    }
    barsByInstrument[instrument] = inserted;
    total += inserted;
    log.info(
      { instrument, inserted, first: bars[0]?.timestampUtc, last: bars[bars.length - 1]?.timestampUtc },
      "coinmetrics instrument loaded",
    );
  }
  return {
    instrumentsLoaded: Object.values(assets),
    barsByInstrument,
    totalBars: total,
  };
}
