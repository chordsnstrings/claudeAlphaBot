/**
 * Walk-forward research driver (goal: find a method with consistent OOS profit).
 *
 * The engine's walk-forward module only PLANS windows + aggregates; this is
 * the executor that actually runs each in-sample / out-of-sample window as a
 * child backtest session and feeds the results back.
 *
 * Warm-up handling (critical for rolling-window strategies): each window's
 * data feed starts `warmupDays` calendar days BEFORE the window's official
 * start so indicators (SMA200, pastReturn252, ATR14, …) are warm by the
 * window boundary. Metrics are then computed ONLY from trades whose entry
 * falls inside the official window, so IS and OOS never leak into each other.
 *
 * Multi-instrument: one strategy instance per instrument runs in a single
 * session, so a window produces enough trades for a meaningful Sharpe.
 */

import { randomUUID } from "node:crypto";

import { randomUUID as uuid } from "node:crypto";

import {
  DEFAULT_RISK_CONFIG,
  logger,
  resolveSystemConfig,
  type Orchestrator,
  type OrchestratorContext,
  type OrderRequest,
  type Signal,
  type Strategy,
  type SystemConfig,
} from "@trading/core";
import { buildBacktestDeps } from "@trading/adapters";
import {
  planWalkForwardWindows,
  summariseWalkForward,
  TradingSystem,
  type WindowResult,
  type WalkForwardSummary,
} from "@trading/engine";
import { MetricsCollector, type ClosedTrade } from "@trading/metrics";
import { computeLotSize } from "@trading/risk";
import {
  BollingerReversalStrategy,
  DonchianBreakoutStrategy,
  TimeSeriesMomentumStrategy,
  TrendFollowingStrategy,
} from "@trading/strategies";
import type { TradeRow } from "@trading/data";

import { buildContext } from "./context.js";

const log = logger("cli.research");

/** Standard-lot units (matches @trading/risk / adapters). */
function standardLotUnits(instrument: string): number {
  switch (instrument) {
    case "XAUUSD":
      return 100;
    case "XAGUSD":
      return 5000;
    case "BRENTCMDUSD":
    case "LIGHTCMDUSD":
      return 100;
    default:
      return 100_000;
  }
}

/** Realistic per-position leverage ceiling. Retail FX margin is ~30:1; we
 * cap a single position's notional at MAX_LEVERAGE × equity so tight-stop
 * strategies (e.g. mean-reversion entering just beyond a recent extreme)
 * cannot synthesise 50×+ leverage via risk-based sizing. Without this the
 * backtest massively overstates tight-stop strategies — especially on
 * close-only daily data where stops never gap through. */
const MAX_LEVERAGE_PER_POSITION = 10;

/**
 * Orchestrator factory that sizes each signal to risk a fixed fraction of
 * account equity (via @trading/risk computeLotSize) instead of a flat 1 lot,
 * then clamps notional to MAX_LEVERAGE_PER_POSITION × equity.
 *
 * `riskPerTradePct` MUST be small enough that the full diversified book
 * fits under the RiskManager's maxTotalOpenRiskPct (6%): N instruments ×
 * riskPerTradePct <= 6%. Otherwise the cap arbitrarily drops trades AND the
 * blocked instruments re-signal every bar (signal_log insert storm). For a
 * ~9-instrument book, ~0.5% keeps the whole portfolio investable.
 */
function makeRiskSizedOrchestrator(riskPerTradePct: number): Orchestrator {
  const riskConfig = { ...DEFAULT_RISK_CONFIG, riskPerTradePct };
  return {
    process(signals: Signal[], ctx: OrchestratorContext): OrderRequest[] {
      const orders: OrderRequest[] = [];
      for (const s of signals) {
        const riskLot = computeLotSize({
          signal: s,
          accountEquityUsd: ctx.accountEquityUsd,
          riskConfig,
          currentDrawdownPct: 0,
        });
        if (riskLot <= 0) {
          continue;
        }
        // Leverage cap: notional = entry × units × lots <= maxLev × equity.
        const units = standardLotUnits(s.instrument);
        const notionalPerLot = s.proposedEntryPrice * units;
        const maxLot =
          notionalPerLot > 0
            ? (MAX_LEVERAGE_PER_POSITION * ctx.accountEquityUsd) / notionalPerLot
            : riskLot;
        const lotSize = Math.max(0, Math.min(riskLot, maxLot));
        if (lotSize < 0.01) {
          continue;
        }
        orders.push({
          clientOrderId: uuid(),
          signal: s,
          instrument: s.instrument,
          direction: s.direction,
          orderType: "market",
          lotSize,
          price: null,
          stopPrice: s.proposedStopPrice,
          targetPrice: s.proposedTargetPrice,
          originatingStrategy: s.originatingStrategy,
          metadata: { riskSized: true, riskPerTradePct, leverageCapped: lotSize < riskLot },
        });
      }
      return orders;
    },
  };
}

const INITIAL_EQUITY = 100_000;
const DEFAULT_RISK_PER_TRADE_PCT = 0.5;
const WARMUP_DAYS = 420; // ~300 trading days, covers SMA200 + pastReturn252

type StrategyFactory = (instrument: string) => Strategy;

const DAILY_STRATEGIES: Record<string, (params?: Record<string, number>) => StrategyFactory> = {
  "trend-following": (p) => (inst) => new TrendFollowingStrategy(inst, p ?? {}),
  "donchian-breakout": (p) => (inst) => new DonchianBreakoutStrategy(inst, p ?? {}),
  "bollinger-reversal": (p) => (inst) => new BollingerReversalStrategy(inst, p ?? {}),
  tsmom: (p) => (inst) => new TimeSeriesMomentumStrategy(inst, p ?? {}),
};

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface RunBacktestArgs {
  strategyName: string;
  params?: Record<string, number> | undefined;
  instruments: string[];
  /** Official window start (trades before this are dropped from metrics). */
  windowFrom: Date;
  windowTo: Date;
  seed: bigint;
  /** Per-trade risk fraction (%). Keep N × this <= 6% total cap. */
  riskPerTradePct: number;
  sessionType:
    | "single_backtest"
    | "walk_forward_window"
    | "parameter_sweep_instance";
  parentSessionId?: string;
}

export interface WindowMetrics {
  sessionId: string;
  sharpe: number;
  expectancyR: number;
  netPnlUsd: number;
  totalReturnPct: number;
  tradeCount: number;
  winRate: number;
}

/**
 * Run one multi-instrument backtest over [windowFrom - warmup, windowTo],
 * then compute metrics from only the trades that entered inside the
 * official window.
 */
export async function runWindowBacktest(
  ctx: ReturnType<typeof buildContext>,
  args: RunBacktestArgs,
): Promise<WindowMetrics> {
  const factoryBuilder = DAILY_STRATEGIES[args.strategyName];
  if (factoryBuilder === undefined) {
    throw new Error(`unknown daily strategy: ${args.strategyName}`);
  }
  const factory = factoryBuilder(args.params);

  const feedFrom = addDays(args.windowFrom, -WARMUP_DAYS);
  const sessionId = randomUUID();

  await ctx.repos.sessions.create({
    id: sessionId,
    mode: "backtest",
    sessionType: args.sessionType,
    parentSessionId: args.parentSessionId ?? null,
    codeVersion: process.env["CODE_VERSION"] ?? "research",
    instruments: args.instruments,
    timeframes: ["d1"],
    dateRangeFrom: args.windowFrom,
    dateRangeTo: args.windowTo,
    strategies: [{ name: args.strategyName, config: args.params ?? {} }],
    orchestratorMode: "equal_weight",
    randomSeed: args.seed,
    initialEquityUsd: INITIAL_EQUITY.toFixed(2),
    currentEquityUsd: INITIAL_EQUITY.toFixed(2),
    riskConfig: DEFAULT_RISK_CONFIG,
    status: "running",
  });

  const config: SystemConfig = resolveSystemConfig(
    {
      NODE_ENV: "development",
      LOG_LEVEL: "warn",
      MODE: "backtest",
      DATABASE_URL: process.env["DATABASE_URL"] ?? "",
      DATABASE_POOL_SIZE: 4,
      HTTP_PORT: 3000,
      HTTP_HOST: "0.0.0.0",
      backtest: {
        BACKTEST_START_DATE: iso(feedFrom),
        BACKTEST_END_DATE: iso(args.windowTo),
        BACKTEST_INITIAL_EQUITY_USD: INITIAL_EQUITY,
        BACKTEST_FRICTION_PROFILE: "pepperstone_razor",
        BACKTEST_RANDOM_SEED: args.seed,
      },
      live: null,
    },
    {
      sessionId,
      strategies: [],
      orchestratorMode: "equal_weight",
      codeVersion: "research",
      instruments: args.instruments,
      timeframes: ["d1"],
    },
  );

  const strategies = args.instruments.map((inst) => factory(inst));
  const built = await buildBacktestDeps(config, {
    strategies,
    orchestrator: makeRiskSizedOrchestrator(args.riskPerTradePct),
  });
  // Warm-up boundary: bars before windowFrom warm indicators only; trading
  // starts exactly at the window, so every trade belongs to the window.
  built.deps.tradingStartsAt = args.windowFrom;
  try {
    const system = new TradingSystem(built.deps);
    await system.run();
    // Force-close any positions still open at window end so their P&L is
    // realised and attributed to the window (exit reason data_end).
    const open = await built.deps.execution.getOpenPositions();
    for (const p of open) {
      await built.deps.execution.closePosition(p.id, { reason: "data_end" });
    }
  } finally {
    await built.close();
  }

  // Every trade in the session belongs to the window (trading was gated to
  // start at windowFrom and all positions were force-closed at windowTo).
  const trades = await ctx.repos.trades.findBySession(sessionId);
  const m = metricsFor(trades);

  await ctx.repos.sessions.updateStatus(sessionId, "completed", {
    endedAt: new Date(),
    tradeCount: trades.length,
    aggregateMetrics: {
      sharpe: m.sharpe,
      expectancyR: m.expectancyR,
      netPnlUsd: m.netPnlUsd,
      totalReturnPct: m.totalReturnPct,
      tradeCount: m.tradeCount,
      winRate: m.winRate,
    },
  });

  return { sessionId, ...m };
}

function metricsFor(trades: TradeRow[]): Omit<WindowMetrics, "sessionId"> {
  const collector = new MetricsCollector({ initialEquityUsd: INITIAL_EQUITY, seed: 42 });
  const closed: ClosedTrade[] = trades.map((t) => ({
    entryTime: t.entryTime,
    exitTime: t.exitTime,
    realizedPnLUsd: Number(t.realizedPnlUsd),
    realizedRMultiple: Number(t.realizedRMultiple),
    originatingStrategy: t.originatingStrategy,
  }));
  for (const c of closed) {
    collector.recordTrade(c);
  }
  const snap = collector.snapshot();
  return {
    sharpe: snap.equity.sharpe.point,
    expectancyR: snap.trades.expectancyR,
    netPnlUsd: snap.equity.finalUsd - INITIAL_EQUITY,
    totalReturnPct: snap.equity.totalReturnPct * 100,
    tradeCount: snap.trades.n,
    winRate: snap.trades.winRate.point,
  };
}

export interface WalkForwardRunArgs {
  strategyName: string;
  params?: Record<string, number> | undefined;
  instruments: string[];
  from: Date;
  to: Date;
  trainMonths: number;
  testMonths: number;
  stepMonths: number;
  minTradesPerWindow: number;
  riskPerTradePct?: number;
  seed?: bigint;
}

export interface WalkForwardRunResult {
  summary: WalkForwardSummary;
  /** Aggregate OOS-only stats stitched across all windows. */
  oos: {
    totalTrades: number;
    netPnlUsd: number;
    meanExpectancyR: number;
    profitableWindowFraction: number;
  };
}

export async function runWalkForward(
  ctx: ReturnType<typeof buildContext>,
  args: WalkForwardRunArgs,
): Promise<WalkForwardRunResult> {
  const windows = planWalkForwardWindows({
    from: args.from,
    to: args.to,
    trainMonths: args.trainMonths,
    testMonths: args.testMonths,
    stepMonths: args.stepMonths,
    minTradesPerWindow: args.minTradesPerWindow,
  });
  const parentSessionId = randomUUID();
  const seed = args.seed ?? 42n;

  // Create the parent session up front so child windows can FK to it.
  await ctx.repos.sessions.create({
    id: parentSessionId,
    mode: "backtest",
    sessionType: "orchestrator_backtest",
    codeVersion: process.env["CODE_VERSION"] ?? "research",
    instruments: args.instruments,
    timeframes: ["d1"],
    dateRangeFrom: args.from,
    dateRangeTo: args.to,
    strategies: [{ name: args.strategyName, config: args.params ?? {} }],
    orchestratorMode: "equal_weight",
    randomSeed: seed,
    initialEquityUsd: INITIAL_EQUITY.toFixed(2),
    currentEquityUsd: INITIAL_EQUITY.toFixed(2),
    riskConfig: DEFAULT_RISK_CONFIG,
    status: "running",
  });

  const riskPerTradePct = args.riskPerTradePct ?? DEFAULT_RISK_PER_TRADE_PCT;
  const results: WindowResult[] = [];
  let oosTotalTrades = 0;
  let oosNetPnl = 0;
  let oosExpectancySum = 0;
  let oosProfitableWindows = 0;

  for (const w of windows) {
    const is = await runWindowBacktest(ctx, {
      strategyName: args.strategyName,
      params: args.params,
      instruments: args.instruments,
      windowFrom: w.isFrom,
      windowTo: w.isTo,
      seed,
      riskPerTradePct,
      sessionType: "walk_forward_window",
      parentSessionId,
    });
    const oos = await runWindowBacktest(ctx, {
      strategyName: args.strategyName,
      params: args.params,
      instruments: args.instruments,
      windowFrom: w.oosFrom,
      windowTo: w.oosTo,
      seed,
      riskPerTradePct,
      sessionType: "walk_forward_window",
      parentSessionId,
    });
    results.push({
      window: w,
      isSharpe: is.sharpe,
      oosSharpe: oos.sharpe,
      isTrades: is.tradeCount,
      oosTrades: oos.tradeCount,
      isSessionId: is.sessionId,
      oosSessionId: oos.sessionId,
    });
    oosTotalTrades += oos.tradeCount;
    oosNetPnl += oos.netPnlUsd;
    oosExpectancySum += oos.expectancyR;
    if (oos.netPnlUsd > 0) {
      oosProfitableWindows += 1;
    }
    log.info(
      {
        window: w.index,
        is: { from: iso(w.isFrom), to: iso(w.isTo), sharpe: round(is.sharpe), trades: is.tradeCount },
        oos: { from: iso(w.oosFrom), to: iso(w.oosTo), sharpe: round(oos.sharpe), trades: oos.tradeCount, pnl: round(oos.netPnlUsd) },
      },
      "walk-forward window complete",
    );
  }

  const summary = summariseWalkForward(
    parentSessionId,
    { minTradesPerWindow: args.minTradesPerWindow },
    results,
  );
  return {
    summary,
    oos: {
      totalTrades: oosTotalTrades,
      netPnlUsd: oosNetPnl,
      meanExpectancyR: windows.length === 0 ? 0 : oosExpectancySum / windows.length,
      profitableWindowFraction:
        windows.length === 0 ? 0 : oosProfitableWindows / windows.length,
    },
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** CLI entrypoint for a single walk-forward run. */
export interface WalkForwardCliOpts {
  strategy: string;
  instruments: string;
  from: string;
  to: string;
  trainMonths: number;
  testMonths: number;
  minTrades: number;
}

export async function runWalkForwardCli(opts: WalkForwardCliOpts): Promise<number> {
  const ctx = buildContext();
  try {
    const result = await runWalkForward(ctx, {
      strategyName: opts.strategy,
      instruments: opts.instruments.split(",").map((s) => s.trim()),
      from: new Date(`${opts.from}T00:00:00Z`),
      to: new Date(`${opts.to}T00:00:00Z`),
      trainMonths: opts.trainMonths,
      testMonths: opts.testMonths,
      stepMonths: opts.testMonths,
      minTradesPerWindow: opts.minTrades,
    });
    log.info(
      {
        strategy: opts.strategy,
        windows: result.summary.windowCount,
        meanIsSharpe: round(result.summary.meanIsSharpe),
        meanOosSharpe: round(result.summary.meanOosSharpe),
        wfConsistency: round(result.summary.walkForwardConsistency),
        oos: {
          netPnlUsd: round(result.oos.netPnlUsd),
          totalTrades: result.oos.totalTrades,
          meanExpectancyR: round(result.oos.meanExpectancyR),
          profitableWindowFraction: round(result.oos.profitableWindowFraction),
        },
      },
      "WALK-FORWARD RESULT",
    );
    return 0;
  } finally {
    await ctx.close();
  }
}
