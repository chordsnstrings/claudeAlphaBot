/**
 * TradingSystem — the mode-agnostic event loop.
 *
 * Spec §9.5 T5.6. The class is IDENTICAL between backtest and live; only
 * the adapters it's constructed with differ.
 *
 * Lifecycle:
 *   1. `run()` starts the data feed + execution adapter, calls
 *      `initialize(ctx)` on every strategy, then loops over each
 *      subscribed (instrument, timeframe) in parallel.
 *   2. For each bar:
 *        - Append to the rolling buffer
 *        - Compute IndicatorSnapshot
 *        - Build MarketState
 *        - Ask each strategy for signals
 *        - Run orchestrator + risk on the signals
 *        - Submit approved orders via the execution adapter
 *        - Record audit events
 *        - Notify strategies of position events that arrived this bar
 *        - Update strategy state
 *        - Collect metrics
 *   3. `stop()` halts the loop, calls `shutdown()` on every strategy and
 *      stops the adapters.
 */

import {
  computeIndicators,
  logger,
  type Bar,
  type ClosedTradeRecord,
  type MarketState,
  type OrderRequest,
  type OrderResult,
  type OrderUpdate,
  type Position,
  type PositionEvent,
  type SessionContext,
  type Signal,
  type Timeframe,
} from "@trading/core";

import {
  barKey,
  isCompleteBar,
  type BarKey,
  type PerBarStats,
  type TradingSystemDeps,
} from "./types.js";

const log = logger("engine");

const DEFAULT_RECENT_BARS = 500;

/** Until Phase 11 ships sessions, fill with conservative defaults. */
function emptySessionContext(): SessionContext {
  return {
    asianHigh: null,
    asianLow: null,
    currentSession: "closed",
    secondsToSessionClose: 0,
    isInNewsWindow: false,
  };
}

export class TradingSystem {
  private running = false;
  private stopped = false;
  private readonly recentBars = new Map<BarKey, Bar[]>();
  private readonly window: number;
  private readonly stats: PerBarStats[] = [];

  constructor(private readonly deps: TradingSystemDeps) {
    this.window = deps.recentBarsWindow ?? DEFAULT_RECENT_BARS;
  }

  /** Process all bars for every subscription until each feed completes. */
  async run(): Promise<void> {
    if (this.running) {
      throw new Error("TradingSystem.run() called twice");
    }
    this.running = true;
    log.info(
      {
        sessionId: this.deps.sessionId,
        mode: this.deps.mode,
        strategies: this.deps.strategies.map((s) => s.name),
        subscriptions: this.deps.subscriptions,
      },
      "starting trading system",
    );

    await this.deps.dataFeed.start();
    await this.deps.execution.start();

    // Initialize strategies once per session.
    const initialAccount = await this.deps.execution.getAccountInfo();
    for (const s of this.deps.strategies) {
      await s.initialize({
        sessionId: this.deps.sessionId,
        config: s.config,
        mode: this.deps.mode,
        initialEquityUsd: initialAccount.equityUsd,
      });
    }

    try {
      await Promise.all(
        this.deps.subscriptions.map(async (sub) => {
          await this.consumeFeed(sub.instrument, sub.timeframe);
        }),
      );
    } finally {
      await this.shutdown();
    }
  }

  /** Stop the loop cooperatively; in-flight bar processing finishes first. */
  async stop(): Promise<void> {
    this.stopped = true;
  }

  /** Snapshot of per-bar processing stats (used in tests + reports). */
  getStats(): readonly PerBarStats[] {
    return this.stats;
  }

  // ---------------------------------------------------------------- internals

  private async consumeFeed(instrument: string, timeframe: Timeframe): Promise<void> {
    for await (const bar of this.deps.dataFeed.subscribe(instrument, timeframe)) {
      if (this.stopped) {
        break;
      }
      if (!isCompleteBar(bar)) {
        log.warn({ instrument, timeframe, ts: bar.timestampUtc }, "skipping malformed bar");
        continue;
      }
      await this.processBar(bar);
    }
  }

  private async processBar(bar: Bar): Promise<void> {
    const key = barKey(bar.instrument, bar.timeframe);
    const buf = this.recentBars.get(key) ?? [];
    buf.push(bar);
    if (buf.length > this.window) {
      buf.splice(0, buf.length - this.window);
    }
    this.recentBars.set(key, buf);

    const indicators = computeIndicators(buf);

    // Phase 7+: drive the backtest execution adapter forward — it detects
    // stop/target hits, closes any triggered positions, and returns the
    // synthetic order updates so the engine can dispatch them BEFORE
    // strategies see this bar's state.
    const positionsBeforeBar = await this.deps.execution.getOpenPositions();
    let closedThisBar: ClosedTradeRecord[] = [];
    if (this.deps.execution.processBar !== undefined) {
      const updates = await this.deps.execution.processBar(bar, {
        atr14: indicators.atr14,
        medianAtr14_60d: null,
      });
      closedThisBar = await this.fanOutOrderUpdates(updates, positionsBeforeBar, bar);
    }

    const account = await this.deps.execution.getAccountInfo();
    const openPositions = await this.deps.execution.getOpenPositions();
    const positionsByStrategy = new Map<string, Position[]>();
    for (const p of openPositions) {
      const list = positionsByStrategy.get(p.originatingStrategy) ?? [];
      list.push(p);
      positionsByStrategy.set(p.originatingStrategy, list);
    }

    const stats: PerBarStats = {
      instrument: bar.instrument,
      timeframe: bar.timeframe,
      timestampUtc: bar.timestampUtc,
      signalsThisBar: 0,
      ordersThisBar: 0,
      ordersRejected: 0,
      ordersExecuted: 0,
    };

    const allSignals: Signal[] = [];
    for (const strat of this.deps.strategies) {
      // Only ask strategies that are configured for this instrument/timeframe.
      if (!strat.config.instruments.includes(bar.instrument)) {
        continue;
      }
      if (!strat.config.timeframes.includes(bar.timeframe)) {
        continue;
      }
      if (!strat.config.enabled) {
        continue;
      }
      const state: MarketState = {
        currentBar: bar,
        instrument: bar.instrument,
        recentBars: buf,
        indicators,
        sessionContext: emptySessionContext(),
        currentPositions: positionsByStrategy.get(strat.name) ?? [],
        accountEquity: account.equityUsd,
        now: this.deps.clock.now(),
      };
      const sigs = await strat.generateSignals(state);
      allSignals.push(...sigs);
      await strat.updateState(state);
    }
    stats.signalsThisBar = allSignals.length;

    // Orchestrator + risk + execution.
    if (allSignals.length > 0) {
      const orders = this.deps.orchestrator.process(allSignals, {
        accountEquityUsd: account.equityUsd,
        totalOpenRiskPct: account.totalOpenRiskPct,
      });
      stats.ordersThisBar = orders.length;
      for (const order of orders) {
        const decision = this.deps.riskManager.canExecute(order, account);
        if (!decision.allowed) {
          stats.ordersRejected += 1;
          await this.deps.auditLog.recordSignal({
            signal: order.signal,
            becameTrade: false,
            rejectedReason: decision.reason ?? "risk_gate_rejected",
          });
          continue;
        }
        const result = await this.submitWithCapturedSize(order, decision.adjustedLotSize);
        stats.ordersExecuted += 1;
        const becameTrade = result.status === "filled" || result.status === "partially_filled";
        await this.deps.auditLog.recordSignal(
          result.status === "rejected"
            ? {
                signal: order.signal,
                becameTrade,
                result,
                rejectedReason: result.rejectionReason ?? "broker_rejected",
              }
            : { signal: order.signal, becameTrade, result },
        );
      }
    }

    // Metrics — feed in any closes that happened on this bar.
    this.deps.metrics.update(
      {
        currentBar: bar,
        instrument: bar.instrument,
        recentBars: buf,
        indicators,
        sessionContext: emptySessionContext(),
        currentPositions: openPositions,
        accountEquity: account.equityUsd,
        now: this.deps.clock.now(),
      },
      closedThisBar,
    );

    this.stats.push(stats);
  }

  private async submitWithCapturedSize(
    order: OrderRequest,
    adjustedLotSize: number | null,
  ): Promise<OrderResult> {
    const final = adjustedLotSize !== null && adjustedLotSize !== order.lotSize
      ? { ...order, lotSize: adjustedLotSize }
      : order;
    return this.deps.execution.submitOrder(final);
  }

  /**
   * Convert OrderUpdates emitted by `execution.processBar(...)` into
   * PositionEvents, dispatch them to the owning strategy, and return the
   * resulting ClosedTradeRecord list for the MetricsCollector.
   */
  private async fanOutOrderUpdates(
    updates: readonly OrderUpdate[],
    positionsBeforeBar: readonly Position[],
    bar: Bar,
  ): Promise<ClosedTradeRecord[]> {
    const byBrokerPositionId = new Map<string, Position>();
    for (const p of positionsBeforeBar) {
      if (p.brokerPositionId !== null) {
        byBrokerPositionId.set(p.brokerPositionId, p);
      }
    }
    const closed: ClosedTradeRecord[] = [];
    for (const u of updates) {
      if (u.status !== "filled" && u.status !== "partially_filled") {
        continue;
      }
      if (u.brokerPositionId === null) {
        continue;
      }
      const pos = byBrokerPositionId.get(u.brokerPositionId);
      if (pos === undefined) {
        continue;
      }
      const exitPrice = u.fillPrice ?? bar.close;
      const exitTime = u.fillTime ?? bar.timestampUtc;
      const move = exitPrice - pos.entryPrice;
      const signedMove = pos.direction === "long" ? move : -move;
      const realizedPnLUsd =
        signedMove * pos.lotSize * standardLotUnitsFor(pos.instrument);
      const realizedPnLPct =
        pos.initialRiskUsd > 0
          ? (realizedPnLUsd / pos.initialRiskUsd) * pos.initialRiskPct
          : 0;
      const rMultiple = pos.initialRiskUsd > 0 ? realizedPnLUsd / pos.initialRiskUsd : 0;
      const event: PositionEvent = {
        type: "closed",
        position: pos,
        exitReason: inferExitReason(pos, bar),
        exitPrice,
        exitTime,
        realizedPnLUsd,
        realizedPnLPct,
        realizedRMultiple: rMultiple,
      };
      for (const s of this.deps.strategies) {
        if (s.name === pos.originatingStrategy) {
          await s.onPositionEvent(event);
        }
      }
      closed.push({
        position: pos,
        exitPrice,
        exitTime,
        realizedPnLUsd,
        realizedPnLPct,
        realizedRMultiple: rMultiple,
      });
    }
    return closed;
  }

  private async shutdown(): Promise<void> {
    for (const s of this.deps.strategies) {
      try {
        await s.shutdown();
      } catch (err) {
        log.error({ strategy: s.name, err: errMsg(err) }, "strategy shutdown failed");
      }
    }
    await this.deps.dataFeed.stop();
    await this.deps.execution.stop();
    log.info({ sessionId: this.deps.sessionId, bars: this.stats.length }, "trading system stopped");
  }
}

/** Helper used by both this file and the integration test fixtures. */
export function emptyPositionEvents(): PositionEvent[] {
  return [];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function standardLotUnitsFor(instrument: string): number {
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

/** Best-effort exit-reason inference from the bar OHLC vs the position's
 * stop/target — for live order updates that don't carry a reason. The
 * SimulatedExecutionAdapter records its own reasons authoritatively. */
function inferExitReason(p: Position, bar: Bar): "stop" | "target" | "manual_close" {
  if (p.direction === "long") {
    if (bar.low <= p.currentStopPrice) {return "stop";}
    if (bar.high >= p.currentTargetPrice) {return "target";}
  } else {
    if (bar.high >= p.currentStopPrice) {return "stop";}
    if (bar.low <= p.currentTargetPrice) {return "target";}
  }
  return "manual_close";
}
