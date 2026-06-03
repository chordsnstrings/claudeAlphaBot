// index.ts — entrypoint. Starts the bot loop.
import { runLoop, tickOnce } from "./bot";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--once")) {
    await tickOnce();
    process.exit(0);
  }
  await runLoop();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
