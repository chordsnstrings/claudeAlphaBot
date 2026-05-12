/**
 * `pnpm backtest --strategy <name> --instrument <symbol>
 *   --timeframe <tf> --from <yyyy-mm-dd> --to <yyyy-mm-dd>`
 *
 * Spec §9.8. End-to-end backtest run:
 *   1. Create session row (status='running')
 *   2. Wire HistoricalDataFeed + SimulatedExec + SimulatedClock via
 *      buildBacktestDeps
 *   3. Drive TradingSystem through every bar
 *   4. On success: update session to status='completed' with aggregate
 *      metrics; on failure: status='failed' with the error
 *
 * Strategies are resolved by name from the registry (Phase 11 adds real
 * strategies; until then, only the built-in 'noop' is available).
 */

import { randomUUID } from "node:crypto";

import {
  DEFAULT_RISK_CONFIG,
  logger,
  resolveSystemConfig,
  type Strategy,
  type StrategyConfig,
  type SystemConfig,
  type Timeframe,
} from "@trading/core";
import { buildBacktestDeps } from "@trading/adapters";
import { TradingSystem } from "@trading/engine";

import { buildContext } from "./context.js";

const log = logger("cli.backtest");

export interface BacktestCliOpts {
  strategy: string;
  instrument: string;
  timeframe: Timeframe;
  from: string;
  to: string;
}

/** Minimal Strategy that emits zero signals; spec §9.8 verification uses this. */
function buildNoopStrategy(instrument: string, timeframe: Timeframe): Strategy {
  const cfg: StrategyConfig = {
    name: "noop",
    parameters: {},
    instruments: [instrument],
    timeframes: [timeframe],
    allocationFraction: 1,
    enabled: true,
  };
  return {
    name: cfg.name,
    config: cfg,
    // eslint-disable-next-line @typescript-eslint/require-await
    async initialize() {
      /* no-op */
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async generateSignals() {
      return [];
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async updateState() {
      /* no-op */
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async onPositionEvent() {
      /* no-op */
    },
    getOpenPositions() {
      return [];
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async shutdown() {
      /* no-op */
    },
  };
}

const STRATEGY_REGISTRY: Record<
  string,
  (instrument: string, timeframe: Timeframe) => Strategy
> = {
  noop: buildNoopStrategy,
};

export async function runBacktest(opts: BacktestCliOpts): Promise<number> {
  const strategyFactory = STRATEGY_REGISTRY[opts.strategy];
  if (strategyFactory === undefined) {
    log.error(
      { available: Object.keys(STRATEGY_REGISTRY) },
      `unknown strategy '${opts.strategy}'`,
    );
    return 2;
  }

  const ctx = buildContext();
  const sessionId = randomUUID();
  let exit = 0;
  let backtestClose: (() => Promise<void>) | null = null;

  try {
    const fromDate = new Date(`${opts.from}T00:00:00Z`);
    const toDate = new Date(`${opts.to}T00:00:00Z`);

    // Persist the session row up front so even an early crash leaves a
    // breadcrumb in the DB.
    await ctx.repos.sessions.create({
      id: sessionId,
      mode: "backtest",
      sessionType: "single_backtest",
      codeVersion: process.env["CODE_VERSION"] ?? "dev",
      instruments: [opts.instrument],
      timeframes: [opts.timeframe],
      dateRangeFrom: fromDate,
      dateRangeTo: toDate,
      strategies: [{ name: opts.strategy, config: {} }],
      orchestratorMode: "equal_weight",
      randomSeed: 42n,
      initialEquityUsd: "100000.00",
      currentEquityUsd: "100000.00",
      riskConfig: DEFAULT_RISK_CONFIG,
      status: "running",
    });

    const config: SystemConfig = resolveSystemConfig(
      {
        NODE_ENV: "development",
        LOG_LEVEL: "info",
        MODE: "backtest",
        DATABASE_URL: process.env["DATABASE_URL"] ?? "",
        DATABASE_POOL_SIZE: 4,
        HTTP_PORT: 3000,
        HTTP_HOST: "0.0.0.0",
        backtest: {
          BACKTEST_START_DATE: opts.from,
          BACKTEST_END_DATE: opts.to,
          BACKTEST_INITIAL_EQUITY_USD: 100_000,
          BACKTEST_FRICTION_PROFILE: "pepperstone_razor",
          BACKTEST_RANDOM_SEED: 42n,
        },
        live: null,
      },
      {
        sessionId,
        strategies: [],
        orchestratorMode: "equal_weight",
        codeVersion: process.env["CODE_VERSION"] ?? "dev",
        instruments: [opts.instrument],
        timeframes: [opts.timeframe],
      },
    );
    const strategy = strategyFactory(opts.instrument, opts.timeframe);
    const built = await buildBacktestDeps(config, { strategies: [strategy] });
    backtestClose = built.close;

    const system = new TradingSystem(built.deps);
    log.info({ sessionId, opts }, "starting backtest");
    await system.run();
    const stats = system.getStats();
    const trades = await ctx.repos.trades.findBySession(sessionId);
    const accountInfo = await built.deps.execution.getAccountInfo();
    const aggregate = {
      barsProcessed: stats.length,
      tradesClosed: trades.length,
      finalEquityUsd: accountInfo.equityUsd,
      finalReturnPct:
        ((accountInfo.equityUsd - 100_000) / 100_000) * 100,
    };

    await ctx.repos.sessions.updateStatus(sessionId, "completed", {
      endedAt: new Date(),
      currentEquityUsd: accountInfo.equityUsd.toFixed(2),
      tradeCount: trades.length,
      aggregateMetrics: aggregate,
    });

    log.info({ sessionId, aggregate }, "backtest complete");
    return 0;
  } catch (err) {
    exit = 1;
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error({ sessionId, err: errMsg }, "backtest failed");
    await ctx.repos.sessions
      .updateStatus(sessionId, "failed", {
        endedAt: new Date(),
        errorDetails: errMsg,
      })
      .catch((updateErr) => {
        log.error({ updateErr }, "could not persist failed status");
      });
    return exit;
  } finally {
    if (backtestClose !== null) {
      await backtestClose();
    }
    await ctx.close();
  }
}
