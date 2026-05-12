/** ingest:asset --instrument EURUSD --timeframe m1 --from 2025-11-01 --to 2026-05-12 */

import { logger } from "@trading/core";
import { ingest, validateInstrumentTimeframe, type IngestTimeframe } from "@trading/data";

import { buildContext } from "./context.js";

const log = logger("cli.ingest-asset");

export interface IngestAssetOpts {
  instrument: string;
  timeframe: IngestTimeframe;
  from: string;
  to: string;
}

export async function runIngestAsset(opts: IngestAssetOpts): Promise<number> {
  const from = new Date(`${opts.from}T00:00:00Z`);
  const to = new Date(`${opts.to}T00:00:00Z`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    log.error({ from: opts.from, to: opts.to }, "invalid date(s)");
    return 2;
  }
  if (from > to) {
    log.error({ from: opts.from, to: opts.to }, "from > to");
    return 2;
  }

  const ctx = buildContext();
  try {
    const result = await ingest(ctx.repos, {
      instrument: opts.instrument,
      timeframe: opts.timeframe,
      from,
      to,
    });
    log.info({ result }, "ingest result");

    if (result.status === "ok" || result.status === "no_data") {
      const summary = await validateInstrumentTimeframe(
        ctx.repos,
        result.canonical,
        opts.timeframe,
        from,
        to,
      );
      log.info({ summary }, "validation summary");
    }
    return result.status === "error" ? 1 : 0;
  } finally {
    await ctx.close();
  }
}
