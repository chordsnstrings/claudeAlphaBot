/**
 * Bot entry point.
 *
 * Boot sequence (in order):
 *   1. Load + validate env (loud error if DATABASE_URL missing, or
 *      BINANCE_* missing in paper/live).
 *   2. Init pino logger.
 *   3. Run DB migrations.
 *   4. Compute code_hash of core + backtest directories.
 *   5. If mode is paper/live: load + verify artifact; abort on any
 *      verification failure (spec §8.11.3).
 *   6. Start /health + /ready server.
 *   7. Route by mode: backtest = idle (CLI is the driver), paper/live
 *      = start the live loop (stubbed until Phase 13/14).
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";

import { loadEnv } from "./config/env.js";
import { getPool, closePool } from "./db/pool.js";
import { runMigrations } from "./db/migrator.js";
import { initLogger } from "./monitoring/logger.js";
import { startHealthServer } from "./monitoring/health.js";
import { computeCodeHash, defaultHashPaths } from "./util/hash.js";
import {
  ArtifactVerificationError,
  loadArtifactFromDisk,
  verifyArtifact,
} from "./core/artifact.js";
import type { ValidatedConfig } from "@hydra/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));

function repoRoot(): string {
  // src/main.ts → ../../..  (packages/bot/src → repo root)
  // dist/main.js → ../../..  (same depth after tsc)
  return resolve(__dirname, "..", "..", "..");
}

let server: FastifyInstance | null = null;
const bootTimeMs = Date.now();

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = initLogger({
    level: env.LOG_LEVEL,
    format: env.LOG_FORMAT,
    nodeEnv: env.NODE_ENV,
  });
  logger.info({ mode: env.BOT_MODE, nodeEnv: env.NODE_ENV }, "hydra boot");

  // DB + migrations
  getPool();
  const migrationResult = await runMigrations();
  logger.info(
    { applied: migrationResult.applied, skipped: migrationResult.skipped },
    "migrations complete",
  );

  // Code hash
  const root = repoRoot();
  const codeHash = await computeCodeHash({ roots: defaultHashPaths(), repoRoot: root });
  logger.info({ codeHash: codeHash.slice(0, 18) + "…" }, "code hash computed");

  // Artifact verification (paper + live only)
  let artifact: ValidatedConfig | null = null;
  if (env.BOT_MODE !== "backtest") {
    if (!env.ARTIFACT_PATH) {
      throw new Error("ARTIFACT_PATH missing for non-backtest mode");
    }
    const loaded = await loadArtifactFromDisk(env.ARTIFACT_PATH);
    const verified = verifyArtifact(loaded, { currentCodeHash: codeHash });
    if (!verified.ok) {
      throw new ArtifactVerificationError(verified.errors);
    }
    artifact = loaded;
    logger.info(
      { codeHash: artifact.codeHash.slice(0, 18) + "…", createdAt: artifact.createdAt, compositeScore: artifact.compositeScore },
      "artifact verified — deployment allowed",
    );
  }

  server = await startHealthServer({
    port: env.BOT_HTTP_PORT,
    logger,
    mode: env.BOT_MODE,
    bootTimeMs,
    artifactInfo: () =>
      artifact
        ? {
            path: env.ARTIFACT_PATH ?? null,
            codeHash: artifact.codeHash,
            createdAt: artifact.createdAt,
            deploymentAllowed: artifact.deploymentAllowed,
          }
        : env.BOT_MODE === "backtest"
          ? null
          : null,
  });

  if (env.BOT_MODE === "backtest") {
    logger.info("mode=backtest: idle. Run CLI with `pnpm run validate-pipeline` or similar.");
    // Backtest mode exits are driven by CLI, not by this process staying up.
    // Keep health server alive for orchestrators that expect a long-running
    // container even in this mode.
  } else {
    logger.info({ mode: env.BOT_MODE }, "paper/live adapter will attach in Phase 13");
    // Phase 13 wires the real execution adapters onto this server.
  }
}

async function shutdown(signal: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: "info", msg: "shutdown", signal }));
  if (server) {
    await server.close();
  }
  await closePool();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch(async (err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("BOOT FAILED:", err);
  try {
    if (server) await server.close();
  } catch {
    // ignore
  }
  await closePool().catch(() => {});
  process.exit(1);
});
