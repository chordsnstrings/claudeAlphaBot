/**
 * Federal Reserve H.10 daily exchange-rate ingestion.
 *
 * Source: https://raw.githubusercontent.com/datasets/exchange-rates/main/data/daily.csv
 * (Frictionless "datasets/exchange-rates" mirror of the Fed H.10 release).
 * Long format: Date,Country,Exchange rate. ~55 years of daily rates for
 * ~22 currencies.
 *
 * Daily rates are a single value per day (the Fed noon buying rate), so we
 * build O=H=L=C bars (source='historical'). Intrabar high/low are not
 * available from this series — close-to-close daily strategies (trend
 * following, Donchian on closes, Bollinger) work correctly; stop/target
 * detection triggers on the close that crosses the level.
 *
 * Quote orientation is normalised to the conventional FX instrument code:
 *   Euro / UK / Australia / New Zealand are already USD-per-unit (EURUSD-style)
 *   the rest are units-per-USD, so we invert to USD-per-unit where the
 *   instrument code puts the foreign currency first (e.g. CADUSD), OR keep
 *   as USDXXX where the code puts USD first. We standardise on the liquid
 *   majors with their familiar codes.
 */

import { logger, type Timeframe } from "@trading/core";
import type { NewBarRow, Repos } from "@trading/data";

const log = logger("data.fed-rates");

export const FED_RATES_URL =
  "https://raw.githubusercontent.com/datasets/exchange-rates/main/data/daily.csv";

/**
 * Map the dataset's "Country" column to an instrument code.
 *
 * Every series is oriented as "USD per 1 unit of the foreign currency"
 * (XXXUSD convention) so backtest P&L is natively USD for every instrument
 * (pnl_usd = priceMove * lotUnits) — correct and comparable across pairs
 * without per-pair currency conversion (spec §6.9 is thereby moot for this
 * dataset). The Fed quotes EUR/GBP/AUD/NZD as USD-per-unit already; the
 * rest are units-per-USD and are inverted (1/rate) to the XXXUSD form.
 */
const CURRENCY_MAP: Record<string, { instrument: string; invert: boolean }> = {
  Euro: { instrument: "EURUSD", invert: false },
  "United Kingdom": { instrument: "GBPUSD", invert: false },
  Australia: { instrument: "AUDUSD", invert: false },
  "New Zealand": { instrument: "NZDUSD", invert: false },
  Japan: { instrument: "JPYUSD", invert: true },
  Canada: { instrument: "CADUSD", invert: true },
  Switzerland: { instrument: "CHFUSD", invert: true },
  Sweden: { instrument: "SEKUSD", invert: true },
  Norway: { instrument: "NOKUSD", invert: true },
  Denmark: { instrument: "DKKUSD", invert: true },
};

export interface FedRatesIngestResult {
  instrumentsLoaded: string[];
  barsByInstrument: Record<string, number>;
  totalBars: number;
}

interface ParsedBar {
  instrument: string;
  date: string; // YYYY-MM-DD
  rate: number;
}

/** Parse the long-format CSV text into per-instrument daily values. */
export function parseFedRatesCsv(csv: string): ParsedBar[] {
  const lines = csv.split("\n");
  const out: ParsedBar[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.length === 0) {
      continue;
    }
    // Split on the LAST two commas only (country names have no commas here,
    // but be defensive): Date,Country,Rate
    const firstComma = line.indexOf(",");
    const lastComma = line.lastIndexOf(",");
    if (firstComma < 0 || lastComma === firstComma) {
      continue;
    }
    const date = line.slice(0, firstComma);
    const country = line.slice(firstComma + 1, lastComma);
    const rateStr = line.slice(lastComma + 1).trim();
    const mapping = CURRENCY_MAP[country];
    if (mapping === undefined) {
      continue;
    }
    const raw = Number(rateStr);
    if (!Number.isFinite(raw) || raw <= 0) {
      continue; // "ND" / blank / zero entries
    }
    const rate = mapping.invert ? 1 / raw : raw;
    out.push({ instrument: mapping.instrument, date, rate });
  }
  return out;
}

/** Build daily OHLC bars (O=H=L=C=rate) for one instrument's series. */
export function toDailyBars(rows: ParsedBar[]): NewBarRow[] {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : 1));
  return sorted.map((r) => {
    const px = r.rate.toFixed(6);
    return {
      instrument: r.instrument,
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

/** Fetch + parse + ingest. Idempotent via BarRepo ON CONFLICT DO NOTHING. */
export async function ingestFedRates(
  repos: Repos,
  opts: { csvText?: string; url?: string } = {},
): Promise<FedRatesIngestResult> {
  let csv = opts.csvText;
  if (csv === undefined) {
    const url = opts.url ?? FED_RATES_URL;
    log.info({ url }, "fetching Fed H.10 daily rates");
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`fed-rates fetch failed: ${res.status}`);
    }
    csv = await res.text();
  }
  const parsed = parseFedRatesCsv(csv);
  const byInstrument = new Map<string, ParsedBar[]>();
  for (const p of parsed) {
    const arr = byInstrument.get(p.instrument) ?? [];
    arr.push(p);
    byInstrument.set(p.instrument, arr);
  }
  const barsByInstrument: Record<string, number> = {};
  let total = 0;
  for (const [instrument, rows] of byInstrument.entries()) {
    const bars = toDailyBars(rows);
    // Insert in chunks to stay under the parameter limit.
    let inserted = 0;
    const CHUNK = 2000;
    for (let i = 0; i < bars.length; i += CHUNK) {
      inserted += await repos.bars.insertMany(bars.slice(i, i + CHUNK));
    }
    barsByInstrument[instrument] = inserted;
    total += inserted;
    log.info({ instrument, inserted }, "fed-rates instrument loaded");
  }
  return {
    instrumentsLoaded: [...byInstrument.keys()],
    barsByInstrument,
    totalBars: total,
  };
}
