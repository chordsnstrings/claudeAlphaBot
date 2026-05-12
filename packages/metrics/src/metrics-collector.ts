/**
 * MetricsCollector — spec §8.1, both final (trade list -> metrics) and
 * incremental (update on each trade close) modes.
 *
 * The class implements @trading/core's `MetricsCollector` interface so the
 * engine can hold it directly. It accumulates a closed-trade list as the
 * backtest runs; `snapshot()` returns the full statistical bundle on
 * demand (engine end-of-run + UI live views both call this).
 */

import type {
  ClosedTradeRecord,
  MarketState,
  MetricsCollector as MetricsCollectorIface,
} from "@trading/core";

import {
  cagr,
  dailyReturns,
  equityCurve,
  maxDrawdown,
  totalReturnPct,
  type ClosedTrade,
  type EquityPoint,
} from "./equity-curve.js";
import { monteCarloShuffle, type MonteCarloOutcome } from "./monte-carlo.js";
import { bootstrapSharpeCi, calmar, sharpeSortino, type BootstrapCi } from "./sharpe.js";
import { mean, percentile, standardError } from "./stats.js";
import { wilsonCi, type ProportionCi } from "./wilson-ci.js";

export interface MetricsSnapshot {
  trades: {
    n: number;
    winRate: ProportionCi;
    expectancyUsd: number;
    expectancySE: number;
    expectancyR: number;
    avgWinR: number;
    avgLossR: number;
    profitFactor: number;
    rPercentiles: { p10: number; p25: number; p50: number; p75: number; p90: number };
  };
  equity: {
    initialUsd: number;
    finalUsd: number;
    totalReturnPct: number;
    cagr: number;
    maxDdUsd: number;
    maxDdPct: number;
    maxDdDurationDays: number;
    calmar: number;
    sharpe: BootstrapCi;
    sortino: number;
  };
  tradeEfficiency: {
    avgHoldMinutes: number;
    /** Trades per calendar day across the backtest span. */
    tradesPerDay: number;
  };
  perStrategy: Record<string, { n: number; netPnlUsd: number; winRate: number }>;
  monteCarlo: MonteCarloOutcome | null;
}

export interface MetricsCollectorOpts {
  initialEquityUsd: number;
  /** Sharpe bootstrap + Monte Carlo seed. */
  seed?: number;
  /** Bootstrap CI resample count (>=1000 per spec §8.3). */
  bootstrapResamples?: number;
  /** Monte Carlo shuffle count (>=1000 per spec §8.5). */
  monteCarloShuffles?: number;
  /** Periods per year for Sharpe annualisation; default 252 (trading days). */
  periodsPerYear?: number;
}

export class MetricsCollector implements MetricsCollectorIface {
  private readonly trades: ClosedTrade[] = [];
  private latestEquity: number;
  private readonly opts: Required<MetricsCollectorOpts>;

  constructor(opts: MetricsCollectorOpts) {
    this.opts = {
      initialEquityUsd: opts.initialEquityUsd,
      seed: opts.seed ?? 42,
      bootstrapResamples: opts.bootstrapResamples ?? 1000,
      monteCarloShuffles: opts.monteCarloShuffles ?? 1000,
      periodsPerYear: opts.periodsPerYear ?? 252,
    };
    this.latestEquity = opts.initialEquityUsd;
  }

  /** Engine hook: invoked per bar with the trades closed THIS bar. */
  update(state: MarketState, closedThisBar: readonly ClosedTradeRecord[]): void {
    this.latestEquity = state.accountEquity;
    for (const c of closedThisBar) {
      this.recordTrade({
        entryTime: c.position.entryTime,
        exitTime: c.exitTime,
        realizedPnLUsd: c.realizedPnLUsd,
        realizedRMultiple: c.realizedRMultiple,
        originatingStrategy: c.position.originatingStrategy,
      });
    }
  }

  /** Direct insertion (used by tests + final-mode replay from DB). */
  recordTrade(t: ClosedTrade): void {
    this.trades.push(t);
  }

  /** Return the full metric bundle. Heavy; call at end-of-session. */
  snapshot(): MetricsSnapshot {
    const trades = this.trades;
    const wins = trades.filter((t) => t.realizedPnLUsd > 0);
    const losses = trades.filter((t) => t.realizedPnLUsd < 0);
    const pnls = trades.map((t) => t.realizedPnLUsd);
    const rs = trades.map((t) => t.realizedRMultiple);

    const winRate = wilsonCi(wins.length, trades.length);
    const expectancyUsd = mean(pnls);
    const expectancySE = standardError(pnls);
    const expectancyR = mean(rs);
    const avgWinR = mean(wins.map((t) => t.realizedRMultiple));
    const avgLossR = mean(losses.map((t) => t.realizedRMultiple));
    const sumWin = wins.reduce((a, t) => a + t.realizedPnLUsd, 0);
    const sumLoss = -losses.reduce((a, t) => a + t.realizedPnLUsd, 0);
    const profitFactor = sumLoss === 0 ? (sumWin > 0 ? Infinity : 0) : sumWin / sumLoss;

    const curve: EquityPoint[] = equityCurve(this.opts.initialEquityUsd, trades);
    const finalUsd = curve[curve.length - 1]?.equityUsd ?? this.latestEquity;
    const totRetPct = totalReturnPct(curve);
    const cag = cagr(curve);
    const dd = maxDrawdown(curve);

    const ret = dailyReturns(curve);
    const ss = sharpeSortino({
      returns: ret,
      periodsPerYear: this.opts.periodsPerYear,
    });
    const sharpeCi = bootstrapSharpeCi(ret, {
      resamples: this.opts.bootstrapResamples,
      periodsPerYear: this.opts.periodsPerYear,
      seed: this.opts.seed,
    });
    const cal = calmar(cag, dd.maxDdPct);

    // Trade efficiency.
    const holdMinutes = trades.map(
      (t) => (t.exitTime.getTime() - t.entryTime.getTime()) / 60_000,
    );
    const avgHold = mean(holdMinutes);
    const spanMs =
      trades.length === 0
        ? 0
        : (trades[trades.length - 1]?.exitTime.getTime() ?? 0) -
          (trades[0]?.entryTime.getTime() ?? 0);
    const days = spanMs <= 0 ? 1 : spanMs / 86_400_000;
    const tradesPerDay = trades.length / days;

    // Per-strategy attribution.
    const perStrategy: MetricsSnapshot["perStrategy"] = {};
    for (const t of trades) {
      const k = t.originatingStrategy;
      const e = perStrategy[k] ?? { n: 0, netPnlUsd: 0, winRate: 0 };
      e.n += 1;
      e.netPnlUsd += t.realizedPnLUsd;
      perStrategy[k] = e;
    }
    for (const k of Object.keys(perStrategy)) {
      const entry = perStrategy[k];
      if (entry === undefined) {
        continue;
      }
      const sw = trades.filter(
        (t) => t.originatingStrategy === k && t.realizedPnLUsd > 0,
      ).length;
      entry.winRate = entry.n === 0 ? 0 : sw / entry.n;
    }

    // Monte Carlo trade reshuffling.
    const monteCarlo =
      trades.length === 0
        ? null
        : monteCarloShuffle({
            initialEquityUsd: this.opts.initialEquityUsd,
            trades,
            shuffles: this.opts.monteCarloShuffles,
            seed: this.opts.seed,
          });

    return {
      trades: {
        n: trades.length,
        winRate,
        expectancyUsd,
        expectancySE,
        expectancyR,
        avgWinR,
        avgLossR,
        profitFactor,
        rPercentiles: {
          p10: percentile(rs, 0.1),
          p25: percentile(rs, 0.25),
          p50: percentile(rs, 0.5),
          p75: percentile(rs, 0.75),
          p90: percentile(rs, 0.9),
        },
      },
      equity: {
        initialUsd: this.opts.initialEquityUsd,
        finalUsd,
        totalReturnPct: totRetPct,
        cagr: cag,
        maxDdUsd: dd.maxDdUsd,
        maxDdPct: dd.maxDdPct,
        maxDdDurationDays: dd.durationDays,
        calmar: cal,
        sharpe: sharpeCi,
        sortino: ss.sortino,
      },
      tradeEfficiency: {
        avgHoldMinutes: avgHold,
        tradesPerDay,
      },
      perStrategy,
      monteCarlo,
    };
  }
}
