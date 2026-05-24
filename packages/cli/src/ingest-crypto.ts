/** `ingest:crypto` — load CoinMetrics daily crypto reference prices. */

import { logger } from "@trading/core";
import { ingestCoinMetrics } from "@trading/data";

import { buildContext } from "./context.js";

const log = logger("cli.ingest-crypto");

export async function runIngestCrypto(): Promise<number> {
  const ctx = buildContext();
  try {
    const result = await ingestCoinMetrics(ctx.repos);
    log.info(
      {
        instruments: result.instrumentsLoaded,
        barsByInstrument: result.barsByInstrument,
        total: result.totalBars,
      },
      "crypto ingest complete",
    );
    return 0;
  } finally {
    await ctx.close();
  }
}
