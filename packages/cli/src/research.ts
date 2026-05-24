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
  lotStep,
  resolveSystemConfig,
  standardLotUnits,
  type Orchestrator,
  type OrchestratorContext,
  type OrderRequest,
  type RiskConfig,
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

/** Realistic per-position leverage ceiling. Retail FX margin is ~30:1; we
 * cap a single position's notional at MAX_LEVERAGE × equity so tight-stop
 * strategies (e.g. mean-reversion entering just beyond a recent extreme)
 * cannot synthesise 50×+ leverage via risk-based sizing. Without this the
 * backtest massively overstates tight-stop strategies — especially on
 * close-only daily data where stops never gap through. */
const DEFAULT_MAX_LEVERAGE_PER_POSITION = 10;

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
/**
 * Risk-overlay knobs that turn the per-trade risk sizer into a portfolio-level
 * volatility-targeted, drawdown-aware sizer (the consistency levers).
 */
export interface VolTargetConfig {
  /** Target annualised equity volatility (e.g. 0.40 = 40%/yr). 0 = off. */
  targetAnnualVol: number;
  /** Trailing window (daily equity samples) for the realised-vol estimate. */
  volWindowDays: number;
  /** Clamp on the vol scaler so it never over/under-levers wildly. */
  volScaleMin: number;
  volScaleMax: number;
  /** Drawdown (fraction) at which de-risking begins / is fully applied. */
  ddStart: number;
  ddFull: number;
  /** Floor the drawdown scaler can reach at/after ddFull. */
  ddMinScale: number;
}

const VOL_TARGET_OFF: VolTargetConfig = {
  targetAnnualVol: 0,
  volWindowDays: 30,
  volScaleMin: 0.25,
  volScaleMax: 2.0,
  ddStart: 0.15,
  ddFull: 0.45,
  ddMinScale: 0.3,
};

/** Crypto trades 365 days/yr; annualise daily vol by sqrt(365). */
const CRYPTO_ANNUALISATION = Math.sqrt(365);

/**
 * Orchestrator factory: sizes each signal to risk `sizingRiskPct` of equity to
 * its stop (per-asset vol targeting, since the stop is ATR-based), clamps
 * notional to `maxLeverage` × equity, and — when `vol.targetAnnualVol > 0` —
 * applies a PORTFOLIO overlay scaler:
 *   - volatility targeting: scale = targetAnnualVol / realisedAnnualVol, so the
 *     book runs hot in calm trends and small in turbulent blow-offs/crashes;
 *   - drawdown de-risking: shrink size as the in-window drawdown deepens.
 * The overlay needs a continuous equity curve, fed via the engine's per-bar
 * `onBar` hook (process() only runs on signal bars).
 */
function makeRiskSizedOrchestrator(
  sizingRiskPct: number,
  maxLeverage: number,
  vol: VolTargetConfig = VOL_TARGET_OFF,
): Orchestrator {
  const riskConfig: RiskConfig = { ...DEFAULT_RISK_CONFIG, riskPerTradePct: sizingRiskPct };
  // Per-window equity-curve state (one sample per calendar day).
  const dailyEquity: number[] = [];
  let lastDate = "";
  let peakEquity = 0;

  function overlayScale(currentEquity: number): number {
    if (vol.targetAnnualVol <= 0) {
      return 1;
    }
    let scale = 1;
    // Volatility targeting from trailing daily log-returns.
    if (dailyEquity.length > vol.volWindowDays) {
      const start = dailyEquity.length - vol.volWindowDays - 1;
      const rets: number[] = [];
      for (let i = start + 1; i < dailyEquity.length; i += 1) {
        const prev = dailyEquity[i - 1];
        const cur = dailyEquity[i];
        if (prev !== undefined && cur !== undefined && prev > 0 && cur > 0) {
          rets.push(Math.log(cur / prev));
        }
      }
      if (rets.length >= 5) {
        const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
        const variance =
          rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / rets.length;
        const annualVol = Math.sqrt(variance) * CRYPTO_ANNUALISATION;
        if (annualVol > 1e-6) {
          const volScale = vol.targetAnnualVol / annualVol;
          scale *= Math.max(vol.volScaleMin, Math.min(vol.volScaleMax, volScale));
        }
      }
    }
    // Drawdown de-risking.
    if (peakEquity > 0) {
      const dd = Math.max(0, (peakEquity - currentEquity) / peakEquity);
      if (dd > vol.ddStart) {
        const frac = Math.min(1, (dd - vol.ddStart) / Math.max(1e-9, vol.ddFull - vol.ddStart));
        const ddScale = 1 - frac * (1 - vol.ddMinScale);
        scale *= ddScale;
      }
    }
    return scale;
  }

  return {
    onBar(equityUsd: number, now: Date): void {
      if (equityUsd > peakEquity) {
        peakEquity = equityUsd;
      }
      const d = now.toISOString().slice(0, 10);
      if (d !== lastDate) {
        dailyEquity.push(equityUsd);
        lastDate = d;
      } else if (dailyEquity.length > 0) {
        dailyEquity[dailyEquity.length - 1] = equityUsd; // keep the day's latest
      }
    },
    process(signals: Signal[], ctx: OrchestratorContext): OrderRequest[] {
      const orders: OrderRequest[] = [];
      const scale = overlayScale(ctx.accountEquityUsd);
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
        const scaledRiskLot = riskLot * scale;
        // Leverage cap: notional = entry × units × lots <= maxLev × equity.
        const units = standardLotUnits(s.instrument);
        const notionalPerLot = s.proposedEntryPrice * units;
        const maxLot =
          notionalPerLot > 0
            ? (maxLeverage * ctx.accountEquityUsd) / notionalPerLot
            : scaledRiskLot;
        const lotSize = Math.max(0, Math.min(scaledRiskLot, maxLot));
        if (lotSize < lotStep(s.instrument)) {
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
          metadata: {
            riskSized: true,
            riskPerTradePct: riskConfig.riskPerTradePct,
            overlayScale: scale,
            leverageCapped: lotSize < scaledRiskLot,
          },
        });
      }
      return orders;
    },
  };
}

const INITIAL_EQUITY = 100_000;
const DEFAULT_RISK_PER_TRADE_PCT = 0.5;
const DEFAULT_WARMUP_DAYS = 420; // ~300 trading days, covers pastReturn252 + SMA200

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
  /** Orchestrator sizing target: fraction of equity risked per trade to its stop. */
  sizingRiskPct: number;
  /** RiskManager caps (per-trade ceiling, total-open, drawdown, daily-loss). */
  riskConfig: RiskConfig;
  /** Per-position notional leverage ceiling (notional <= maxLeverage × equity). */
  maxLeverage: number;
  /** Portfolio vol-target + drawdown de-risk overlay (targetAnnualVol 0 = off). */
  volTarget: VolTargetConfig;
  /** Calendar days of pre-window data to warm indicators. Default 420. */
  warmupDays?: number | undefined;
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

  const feedFrom = addDays(args.windowFrom, -(args.warmupDays ?? DEFAULT_WARMUP_DAYS));
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
    riskConfig: args.riskConfig,
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
      riskConfig: args.riskConfig,
    },
  );

  const strategies = args.instruments.map((inst) => factory(inst));
  const built = await buildBacktestDeps(config, {
    strategies,
    orchestrator: makeRiskSizedOrchestrator(args.sizingRiskPct, args.maxLeverage, args.volTarget),
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
  riskPerTradePct?: number | undefined;
  /** Overrides merged over DEFAULT_RISK_CONFIG (for the RiskManager + sizing). */
  riskConfig?: Partial<RiskConfig> | undefined;
  /** Per-position notional leverage ceiling. Default 10×. */
  maxLeverage?: number | undefined;
  /** Target annualised equity vol as a percent (e.g. 40). 0/undefined = off. */
  volTargetAnnualPct?: number | undefined;
  warmupDays?: number | undefined;
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

  // Orchestrator sizing target (fraction risked per trade to its stop).
  const sizingRiskPct = args.riskPerTradePct ?? DEFAULT_RISK_PER_TRADE_PCT;
  // RiskManager caps. Start from DEFAULT, apply explicit overrides, then make
  // sure the per-trade ceiling sits safely ABOVE the sizing target — otherwise
  // an order sized to exactly the target risk is rejected at the cap (this is
  // what would silently corrupt FX runs if cap == sizing target). Total-open,
  // drawdown and daily-loss gates come straight from the overrides.
  const riskConfig: RiskConfig = {
    ...DEFAULT_RISK_CONFIG,
    ...(args.riskConfig ?? {}),
  };
  riskConfig.riskPerTradePct = Math.max(riskConfig.riskPerTradePct, sizingRiskPct * 2);
  const maxLeverage = args.maxLeverage ?? DEFAULT_MAX_LEVERAGE_PER_POSITION;
  const volTarget: VolTargetConfig = {
    ...VOL_TARGET_OFF,
    targetAnnualVol: (args.volTargetAnnualPct ?? 0) / 100,
  };

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
    riskConfig,
    status: "running",
  });

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
      sizingRiskPct,
      riskConfig,
      maxLeverage,
      volTarget,
      warmupDays: args.warmupDays,
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
      sizingRiskPct,
      riskConfig,
      maxLeverage,
      volTarget,
      warmupDays: args.warmupDays,
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
  params?: Record<string, number> | undefined;
  warmupDays?: number | undefined;
  riskPerTradePct?: number | undefined;
  riskConfig?: Partial<RiskConfig> | undefined;
  maxLeverage?: number | undefined;
  volTargetAnnualPct?: number | undefined;
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
      params: opts.params,
      warmupDays: opts.warmupDays,
      riskPerTradePct: opts.riskPerTradePct,
      riskConfig: opts.riskConfig,
      maxLeverage: opts.maxLeverage,
      volTargetAnnualPct: opts.volTargetAnnualPct,
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
