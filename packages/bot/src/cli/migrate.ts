/**
 * CLI: `pnpm --filter @hydra/bot migrate:up` → runs all pending migrations.
 * There are no down-migrations by design: irreversibility is a feature
 * for financial data.
 */
import "dotenv/config";

import { closePool } from "../db/pool.js";
import { runMigrations } from "../db/migrator.js";

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "up";
  if (cmd !== "up") {
    console.error(`Unknown command: ${cmd}. Only 'up' is supported.`);
    process.exit(2);
  }
  const result = await runMigrations();
  console.log(
    JSON.stringify({
      applied: result.applied,
      skipped: result.skipped,
      appliedCount: result.applied.length,
      skippedCount: result.skipped.length,
    }),
  );
  await closePool();
}

main().catch(async (err: unknown) => {
  console.error("migrate failed:", err);
  await closePool().catch(() => {});
  process.exit(1);
});
