/**
 * Standalone historical-data fetcher for the BTCUSDT strategy study.
 *
 * Pulls 1-hour BTCUSDT klines from the public Binance market-data mirror
 * (`data-api.binance.vision`, which is not geo-restricted like `fapi`) and
 * caches them to `artifacts/btcusdt-1h.json` so the analysis CLI is fully
 * reproducible and offline after the first run. No DB, no API keys.
 *
 * Usage:
 *   tsx src/cli/fetch-btc-data.ts [--start=2024-11-01] [--end=2026-05-25]
 *                                 [--out=artifacts/btcusdt-1h.json]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Candle } from "@hydra/shared";

const BASE = "https://data-api.binance.vision";
const HOUR_MS = 3_600_000;
const MAX_LIMIT = 1000;

interface Args {
  start: string;
  end: string;
  out: string;
}

function parseArgs(argv: readonly string[]): Args {
  let start = "2024-11-01";
  let end = "2026-05-25";
  let out = "artifacts/btcusdt-1h.json";
  for (const a of argv) {
    if (a.startsWith("--start=")) start = a.slice("--start=".length);
    else if (a.startsWith("--end=")) end = a.slice("--end=".length);
    else if (a.startsWith("--out=")) out = a.slice("--out=".length);
  }
  return { start, end, out };
}

type RawKline = readonly [number, string, string, string, string, string, number, ...unknown[]];

async function fetchPage(startMs: number, endMs: number): Promise<readonly Candle[]> {
  const url =
    `${BASE}/api/v3/klines?symbol=BTCUSDT&interval=1h` +
    `&startTime=${startMs}&endTime=${endMs}&limit=${MAX_LIMIT}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status !== 200) {
    throw new Error(`klines ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const rows = (await res.json()) as readonly RawKline[];
  return rows.map((r) => ({
    symbol: "BTCUSDT" as const,
    openTime: r[0],
    closeTime: r[6],
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  }));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startMs = new Date(`${args.start}T00:00:00Z`).getTime();
  const endMs = new Date(`${args.end}T00:00:00Z`).getTime();

  const candles: Candle[] = [];
  let cursor = startMs;
  let pages = 0;
  while (cursor < endMs) {
    const page = await fetchPage(cursor, endMs);
    if (page.length === 0) break;
    for (const c of page) if (c.openTime >= cursor && c.openTime < endMs) candles.push(c);
    const last = page[page.length - 1]!;
    const next = last.openTime + HOUR_MS;
    if (next <= cursor) break; // no forward progress — bail
    cursor = next;
    pages++;
    process.stdout.write(
      `\rfetched ${candles.length} candles over ${pages} pages ` +
        `(through ${new Date(last.openTime).toISOString().slice(0, 13)}Z)   `,
    );
    await new Promise((r) => setTimeout(r, 150)); // polite pacing
  }
  process.stdout.write("\n");

  // Dedupe + sort defensively.
  const byTime = new Map<number, Candle>();
  for (const c of candles) byTime.set(c.openTime, c);
  const sorted = Array.from(byTime.values()).sort((a, b) => a.openTime - b.openTime);

  const outPath = resolve(process.cwd(), args.out);
  await mkdir(resolve(outPath, ".."), { recursive: true });
  const payload = {
    symbol: "BTCUSDT",
    interval: "1h",
    source: `${BASE}/api/v3/klines (spot)`,
    fetchedAt: new Date().toISOString(),
    window: { start: args.start, end: args.end },
    count: sorted.length,
    firstOpen: sorted.length > 0 ? new Date(sorted[0]!.openTime).toISOString() : null,
    lastOpen:
      sorted.length > 0 ? new Date(sorted[sorted.length - 1]!.openTime).toISOString() : null,
    candles: sorted,
  };
  await writeFile(outPath, JSON.stringify(payload));
  // eslint-disable-next-line no-console
  console.log(
    `wrote ${sorted.length} candles to ${args.out} ` +
      `(${payload.firstOpen} → ${payload.lastOpen})`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
