/**
 * Phase 1 stub. Expanded in Phase 3 with:
 *   - env loading (zod)
 *   - migrator run
 *   - health server boot
 *   - mode routing (backtest / paper / live)
 *   - artifact verification for paper/live
 */
import type { BotMode } from "@hydra/shared";

async function main(): Promise<void> {
  const mode = (process.env["BOT_MODE"] ?? "backtest") as BotMode;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: "info", msg: "hydra boot stub", mode }));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
