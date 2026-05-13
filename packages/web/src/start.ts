#!/usr/bin/env -S node --enable-source-maps
/**
 * `pnpm --filter @trading/web start`
 *
 * Boots the operational UI standalone. Reads UI_USERNAME, UI_PASSWORD_HASH,
 * UI_PASSWORD_SALT, UI_SESSION_SECRET, DATABASE_URL from the environment.
 * RuntimeOps is null in this minimal boot — operator actions land via the
 * standalone live entrypoint (Phase 17), which constructs the full
 * TradingSystemDeps + RuntimeOps and passes them into buildServer.
 */

import { DEFAULT_RISK_CONFIG, logger } from "@trading/core";
import { buildRepos, createDb } from "@trading/data";

import { buildServer } from "./server.js";

const log = logger("web.start");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) {
    log.fatal({ name }, "env var missing");
    process.exit(2);
  }
  return v;
}

const port = Number(process.env["HTTP_PORT"] ?? 3000);
const host = process.env["HTTP_HOST"] ?? "0.0.0.0";

const handle = createDb({
  databaseUrl: requireEnv("DATABASE_URL"),
  poolSize: Number(process.env["DATABASE_POOL_SIZE"] ?? 4),
});
const repos = buildRepos(handle.db);

const app = await buildServer({
  authConfig: {
    username: requireEnv("UI_USERNAME"),
    passwordHashHex: requireEnv("UI_PASSWORD_HASH"),
    passwordSaltHex: requireEnv("UI_PASSWORD_SALT"),
    sessionSecret: requireEnv("UI_SESSION_SECRET"),
  },
  repos,
  runtimeOps: null,
  riskConfig: { ...DEFAULT_RISK_CONFIG },
  accountInfo: async () => null,
  openPositions: async () => [],
  startedAt: new Date(),
  codeVersion: process.env["CODE_VERSION"] ?? "dev",
});

await app.listen({ port, host });
log.info({ port, host }, "operational UI listening");
