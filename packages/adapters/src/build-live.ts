/**
 * Live composition root (Phase 17).
 *
 * Wires CTraderDataFeed + CTraderExecutionAdapter + SystemClock into a
 * TradingSystemDeps bundle. Credentials are pulled from environment vars
 * (the standard CTRADER_* set defined by @trading/core/config.ts).
 *
 * Note: this is CODE only — no actual cTrader connection is established
 * until the operator runs Phase 18 to register the cTrader application
 * and complete OAuth. Without credentials in env, both adapters log a
 * clear "credentials missing" message on start() and remain idle.
 *
 * Strategies (and the orchestrator) are caller-supplied via
 * `buildLiveDeps(config, opts)` since live runs are operator-orchestrated.
 */

import { logger, type Orchestrator, type Strategy, type SystemConfig } from "@trading/core";
import { buildRepos, createDb, type Repos } from "@trading/data";
import { registerAdapters, type TradingSystemDeps } from "@trading/engine";
import { MetricsCollector } from "@trading/metrics";
import { AuditLog, RiskManager } from "@trading/risk";
import type pg from "pg";

import {
  CTraderDataFeed,
  type CTraderCredentials,
} from "./ctrader/ctrader-data-feed.js";
import { CTraderExecutionAdapter } from "./ctrader/ctrader-execution-adapter.js";
import { SystemClock } from "./system-clock.js";

const log = logger("adapters.build-live");

const passthroughOrchestrator: Orchestrator = {
  process(signals) {
    return signals.map((s) => ({
      clientOrderId: crypto.randomUUID(),
      signal: s,
      instrument: s.instrument,
      direction: s.direction,
      orderType: "market" as const,
      lotSize: 0.1,
      price: null,
      stopPrice: s.proposedStopPrice,
      targetPrice: s.proposedTargetPrice,
      originatingStrategy: s.originatingStrategy,
      metadata: {},
    }));
  },
};

export interface BuildLiveResult {
  deps: TradingSystemDeps;
  repos: Repos;
  pool: pg.Pool;
  metrics: MetricsCollector;
  close(): Promise<void>;
}

export interface BuildLiveOpts {
  strategies?: Strategy[];
  orchestrator?: Orchestrator;
}

function credsFromConfig(cfg: SystemConfig): CTraderCredentials | null {
  if (cfg.mode !== "live") {
    return null;
  }
  const lv = cfg.live;
  if (
    lv.ctraderClientId === "" ||
    lv.ctraderClientSecret === "" ||
    lv.ctraderAccessToken === ""
  ) {
    return null;
  }
  const accountId = Number(lv.ctraderAccountId);
  if (!Number.isFinite(accountId)) {
    return null;
  }
  return {
    clientId: lv.ctraderClientId,
    clientSecret: lv.ctraderClientSecret,
    accessToken: lv.ctraderAccessToken,
    accountId,
    accountType: lv.accountType,
  };
}

export async function buildLiveDeps(
  config: SystemConfig,
  opts: BuildLiveOpts = {},
): Promise<BuildLiveResult> {
  if (config.mode !== "live") {
    throw new Error("buildLiveDeps: config.mode must be 'live'");
  }
  const handle = createDb({
    databaseUrl: config.database.connectionString,
    poolSize: config.database.poolSize,
  });
  const repos = buildRepos(handle.db);
  const auditLog = new AuditLog(repos, config.sessionId);

  const symbolCache = new Map<string, number>();
  const dataFeed = new CTraderDataFeed(
    {
      loadCredentials: () => credsFromConfig(config),
      repos,
      auditLog,
    },
    {
      instruments: config.live.instrumentsTraded,
      timeframes: ["m1"],
    },
  );
  const execution = new CTraderExecutionAdapter({
    loadCredentials: () => credsFromConfig(config),
    repos,
    auditLog,
    symbolIdByName: () => symbolCache,
  });

  const metrics = new MetricsCollector({
    initialEquityUsd: 100_000, // updated on first account snapshot
  });
  const riskManager = new RiskManager({
    config: config.riskConfig,
    initialEquityUsd: 100_000,
  });

  const subscriptions = config.live.instrumentsTraded.map((inst) => ({
    instrument: inst,
    timeframe: "m1" as const,
  }));

  const deps: TradingSystemDeps = {
    dataFeed,
    execution,
    clock: new SystemClock(),
    strategies: opts.strategies ?? [],
    orchestrator: opts.orchestrator ?? passthroughOrchestrator,
    riskManager,
    metrics,
    auditLog,
    sessionId: config.sessionId,
    mode: "live",
    subscriptions,
  };

  log.info(
    {
      sessionId: config.sessionId,
      accountType: config.live.accountType,
      accountId: config.live.ctraderAccountId,
      hasCredentials: credsFromConfig(config) !== null,
    },
    "live deps built (no connection attempted)",
  );

  return {
    deps,
    repos,
    pool: handle.pool,
    metrics,
    close: () => handle.close(),
  };
}

export function registerLiveAdapters(): void {
  registerAdapters({
    buildLive: async (cfg: SystemConfig) => {
      const { deps } = await buildLiveDeps(cfg);
      return deps;
    },
  });
}
