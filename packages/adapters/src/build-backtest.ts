/**
 * Backtest composition root.
 *
 * Spec §1.4 / §9.8. Wires the three backtest-mode adapters together:
 *   HistoricalDataFeed         — Phase 6
 *   SimulatedExecutionAdapter  — Phase 7
 *   SimulatedClock             — Phase 8
 *
 * Plus the mode-invariant pieces (orchestrator, risk manager, metrics,
 * audit log) — these have stub implementations in the engine for now so
 * an empty backtest can run end-to-end. Real implementations land in
 * Phases 9 (metrics), 10 (risk + audit), and 14 (orchestrator).
 *
 * After importing this module, callers invoke `registerBacktestAdapters()`
 * once at startup to register the factory with `@trading/engine`'s
 * `buildSystem`. The CLI does this on its own; tests can call it directly.
 */

import { logger, type Orchestrator, type Strategy, type SystemConfig } from "@trading/core";
import { buildRepos, createDb, type Repos } from "@trading/data";
import { registerAdapters, type TradingSystemDeps } from "@trading/engine";
import { MetricsCollector } from "@trading/metrics";
import { AuditLog, RiskManager } from "@trading/risk";
import type pg from "pg";

import { FrictionModel } from "./friction/friction-model.js";
import { loadNewsEvents } from "./friction/news.js";
import { HistoricalDataFeed } from "./historical-data-feed.js";
import { SimulatedClock } from "./simulated-clock.js";
import { SimulatedExecutionAdapter } from "./simulated-execution-adapter.js";

const log = logger("adapters.build-backtest");

// ----------------------------------------------------------- stub helpers

const passthroughOrchestrator: Orchestrator = {
  /** Stub until Phase 14: pipe signals straight through to orders. */
  process(signals) {
    return signals.map((s) => ({
      clientOrderId: crypto.randomUUID(),
      signal: s,
      instrument: s.instrument,
      direction: s.direction,
      orderType: "market" as const,
      lotSize: 1,
      price: null,
      stopPrice: s.proposedStopPrice,
      targetPrice: s.proposedTargetPrice,
      originatingStrategy: s.originatingStrategy,
      metadata: {},
    }));
  },
};

// MetricsCollector lives in @trading/metrics (Phase 9); RiskManager and
// AuditLog in @trading/risk (Phase 10). buildBacktestDeps wires them
// directly; the CLI reads `metrics.snapshot()` post-run to populate
// session.aggregateMetrics.

// --------------------------------------------------------- factory itself

export interface BuildBacktestResult {
  deps: TradingSystemDeps;
  /** Used by the CLI to update the session row on completion. */
  repos: Repos;
  pool: pg.Pool;
  metrics: MetricsCollector;
  close(): Promise<void>;
}

export interface BuildBacktestOpts {
  /** Pre-built strategies. The CLI wires real ones; tests can pass []. */
  strategies?: Strategy[];
  /**
   * Optional orchestrator override (default: passthrough). Inject the
   * @trading/orchestrator implementation for multi-strategy runs.
   */
  orchestrator?: Orchestrator;
}

export async function buildBacktestDeps(
  config: SystemConfig,
  opts: BuildBacktestOpts = {},
): Promise<BuildBacktestResult> {
  if (config.mode !== "backtest") {
    throw new Error("buildBacktestDeps: config.mode must be 'backtest'");
  }
  const handle = createDb({
    databaseUrl: config.database.connectionString,
    poolSize: config.database.poolSize,
  });
  const repos = buildRepos(handle.db);
  const clock = new SimulatedClock(config.backtest.startDate);

  const newsEvents = await loadNewsEvents();
  const friction = new FrictionModel({
    profile: config.backtest.frictionProfile,
    randomSeed: config.backtest.randomSeed,
    newsEvents,
  });

  const dataFeed = new HistoricalDataFeed(
    { db: handle.db, pool: handle.pool, clock },
    {
      instruments: config.backtest.instruments,
      timeframes: config.backtest.timeframes,
      from: config.backtest.startDate,
      to: config.backtest.endDate,
    },
  );
  const execution = new SimulatedExecutionAdapter({
    repos,
    friction,
    sessionId: config.sessionId,
    initialEquityUsd: config.backtest.initialEquityUsd,
  });

  const subscriptions = config.backtest.instruments.flatMap((inst) =>
    config.backtest.timeframes.map((tf) => ({ instrument: inst, timeframe: tf })),
  );

  const metrics = new MetricsCollector({
    initialEquityUsd: config.backtest.initialEquityUsd,
    seed: Number(config.backtest.randomSeed & 0xffffffffn),
  });

  const riskManager = new RiskManager({
    config: config.riskConfig,
    initialEquityUsd: config.backtest.initialEquityUsd,
  });

  const deps: TradingSystemDeps = {
    dataFeed,
    execution,
    clock,
    strategies: opts.strategies ?? [],
    orchestrator: opts.orchestrator ?? passthroughOrchestrator,
    riskManager,
    metrics,
    auditLog: new AuditLog(repos, config.sessionId),
    sessionId: config.sessionId,
    mode: "backtest",
    subscriptions,
  };

  log.info(
    {
      sessionId: config.sessionId,
      instruments: config.backtest.instruments,
      timeframes: config.backtest.timeframes,
      from: config.backtest.startDate,
      to: config.backtest.endDate,
      frictionProfile: config.backtest.frictionProfile,
    },
    "backtest deps built",
  );

  return {
    deps,
    repos,
    pool: handle.pool,
    metrics,
    close: () => handle.close(),
  };
}

/** Side-effecting registration with the engine's buildSystem factory. */
export function registerBacktestAdapters(): void {
  registerAdapters({
    buildBacktest: async (cfg: SystemConfig) => {
      const { deps } = await buildBacktestDeps(cfg);
      return deps;
    },
  });
}
