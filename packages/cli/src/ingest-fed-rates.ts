/** `ingest:fed-rates` — load the Fed H.10 daily exchange-rate series. */

import { logger } from "@trading/core";
import { ingestFedRates } from "@trading/data";

import { buildContext } from "./context.js";

const log = logger("cli.ingest-fed-rates");

export async function runIngestFedRates(): Promise<number> {
  const ctx = buildContext();
  try {
    const result = await ingestFedRates(ctx.repos);
    log.info(
      {
        instruments: result.instrumentsLoaded,
        barsByInstrument: result.barsByInstrument,
        total: result.totalBars,
      },
      "fed-rates ingest complete",
    );
    return 0;
  } finally {
    await ctx.close();
  }
}
