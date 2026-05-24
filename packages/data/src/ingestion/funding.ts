/**
 * Perp funding-rate ingestion → synthetic "carry" instrument.
 *
 * The cash-and-carry / funding-harvest trade is the genuinely *steady* crypto
 * strategy: hold a delta-neutral book (long spot, short perp) and collect the
 * funding rate. Its P&L, per unit of capital and ignoring (hedged) price moves,
 * is just the funding stream. We model that here as a synthetic instrument
 * whose daily return EQUALS the funding rate, so the existing engine can trade
 * it directly: a position long the `<ASSET>CARRY` series earns funding when it
 * is positive. A regime/momentum filter on the same series harvests the
 * positive-funding regimes and sits out the negative ones — the carry half of a
 * "right strategy at the right time" orchestrator.
 *
 * Input CSV (one row per asset per day):  date,asset,funding_rate
 *   - date:         YYYY-MM-DD
 *   - asset:        slug matching DEFAULT_CRYPTO_ASSETS keys (btc, eth, …)
 *   - funding_rate: the DAILY funding as a decimal (e.g. 0.0003 = 0.03%/day);
 *                   if your source is per-8h, pre-sum the three into a daily
 *                   figure, or pass --interval to convert (see ingest-funding).
 *
 * NOTE: this is a first-order model. It assumes a perfectly delta-neutral,
 * continuously-rebalanced book and ignores basis-convergence P&L, rebalancing
 * slippage, and borrow on the spot leg. Those are second-order for liquid
 * majors but should be layered in before trusting live sizing.
 *
 * No funding data ships with the repo — supply your own CSV. The ingestion +
 * synthetic-bar math is unit-tested (test/funding.test.ts); the empirical carry
 * return obviously depends entirely on the funding series you provide.
 */

import { logger, type Timeframe } from "@trading/core";
import type { NewBarRow, Repos } from "@trading/data";

const log = logger("data.funding");

export interface FundingIngestResult {
  instrumentsLoaded: string[];
  barsByInstrument: Record<string, number>;
  totalBars: number;
}

export interface ParsedFunding {
  date: string; // YYYY-MM-DD
  asset: string;
  fundingRate: number; // daily decimal
}

/** Parse a `date,asset,funding_rate` CSV (header required, order-insensitive). */
export function parseFundingCsv(csv: string): ParsedFunding[] {
  const lines = csv.split("\n");
  const header = lines[0];
  if (header === undefined) {
    return [];
  }
  const cols = header.split(",").map((c) => c.trim().toLowerCase());
  const di = cols.indexOf("date");
  const ai = cols.indexOf("asset");
  const fi = cols.findIndex((c) => c === "funding_rate" || c === "fundingrate" || c === "funding");
  if (di < 0 || ai < 0 || fi < 0) {
    throw new Error("funding CSV must have columns: date, asset, funding_rate");
  }
  const out: ParsedFunding[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.trim().length === 0) {
      continue;
    }
    const f = line.split(",");
    const date = f[di]?.trim().slice(0, 10);
    const asset = f[ai]?.trim().toLowerCase();
    const rate = Number(f[fi]);
    if (date === undefined || asset === undefined || asset === "" || !Number.isFinite(rate)) {
      continue;
    }
    out.push({ date, asset, fundingRate: rate });
  }
  return out;
}

/**
 * Build the synthetic carry price series for one asset: price compounds by the
 * daily funding rate, so the bar-to-bar return equals funding. O=H=L=C.
 */
export function buildCarryBars(instrument: string, rows: ParsedFunding[], base = 100): NewBarRow[] {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const bars: NewBarRow[] = [];
  let price = base;
  for (const r of sorted) {
    price = price * (1 + r.fundingRate);
    if (!(price > 0)) {
      // Funding can't realistically wipe the synthetic series; guard anyway.
      price = 1e-8;
    }
    const px = price.toFixed(8);
    bars.push({
      instrument,
      timeframe: "d1" as Timeframe,
      timestampUtc: new Date(`${r.date}T00:00:00Z`),
      open: px,
      high: px,
      low: px,
      close: px,
      volume: "0",
      source: "historical",
    } satisfies NewBarRow);
  }
  return bars;
}

/** Fetch/parse/ingest a funding CSV into synthetic `<ASSET>CARRY` instruments. */
export async function ingestFunding(
  repos: Repos,
  opts: { csvText: string; assetToInstrument?: (asset: string) => string },
): Promise<FundingIngestResult> {
  const toInstrument = opts.assetToInstrument ?? ((a: string) => `${a.toUpperCase()}CARRY`);
  const parsed = parseFundingCsv(opts.csvText);
  const byAsset = new Map<string, ParsedFunding[]>();
  for (const p of parsed) {
    const arr = byAsset.get(p.asset) ?? [];
    arr.push(p);
    byAsset.set(p.asset, arr);
  }
  const barsByInstrument: Record<string, number> = {};
  let total = 0;
  for (const [asset, rows] of byAsset.entries()) {
    const instrument = toInstrument(asset);
    const bars = buildCarryBars(instrument, rows);
    let inserted = 0;
    const CHUNK = 2000;
    for (let i = 0; i < bars.length; i += CHUNK) {
      inserted += await repos.bars.insertMany(bars.slice(i, i + CHUNK));
    }
    barsByInstrument[instrument] = inserted;
    total += inserted;
    log.info({ instrument, inserted }, "funding/carry instrument loaded");
  }
  return { instrumentsLoaded: [...byAsset.keys()].map(toInstrument), barsByInstrument, totalBars: total };
}
