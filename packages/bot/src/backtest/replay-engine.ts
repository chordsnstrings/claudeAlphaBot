/**
 * Backtest replay engine per spec §8.3.
 *
 * Strict no-look-ahead policy:
 *   - At timestamp T, strategies see candles[s] WHERE s.openTime ≤ T.
 *   - Exits look ONLY at the candle whose openTime == T (i.e., the candle
 *     that closes at time T+1h). Stop/TP/time-stop hits are detected from
 *     this single candle's OHLC.
 *
 * Multi-symbol: the timeline is the union of all symbols' candle openTimes.
 * For each T we (1) update existing positions using THIS candle, then
 * (2) evaluate strategies for each symbol whose candle openTime == T.
 *
 * Funding: list of FundingRate snapshots. We accrue payments at any
 * settlement timestamp ∈ (entryTime, currentT] that has not yet been
 * accrued for the position.
 */
import type {
  Candle,
  ExitReason,
  FundingRate,
  OpenPosition,
  SignalIntent,
  Symbol as TradingSymbol,
  Trade,
} from "@hydra/shared";

import {
  preTradeChecks,
  recordTradeClose,
  type CircuitBreakerOptions,
} from "../core/circuit-breakers.js";
import { createAccountState } from "../core/circuit-breakers.js";
import {
  DEFAULT_SYMBOL_META,
  sizePosition,
  type RiskOptions,
  type SymbolMeta,
} from "../core/risk.js";

import {
  fundingPayment,
  simulateEntryFill,
  simulateExitForCandle,
  type FeeOptions,
} from "./fill-sim.js";
import {
  applySkim,
  utcMonthIndex,
  utcMonthKey,
  type WithdrawalEvent,
  type WithdrawalPolicy,
} from "./withdrawal.js";

/**
 * A strategy evaluator consumed by the replay engine.
 *
 * `evaluate(symbol, candlesUpToAndIncludingT, hasOpenPosition)` returns a
 * SignalIntent if it wants to fire on candle T, or null. The engine never
 * passes future candles in.
 */
export interface StrategyEvaluator {
  readonly name: string;
  readonly evaluate: (
    symbol: TradingSymbol,
    candles: readonly Candle[],
    hasOpenPosition: boolean,
  ) => SignalIntent | null;
}

export interface ReplayOptions {
  readonly startingEquity: number;
  readonly symbolMeta?: Partial<Record<TradingSymbol, SymbolMeta>>;
  readonly risk?: RiskOptions;
  readonly fees?: FeeOptions;
  readonly circuitBreakers?: CircuitBreakerOptions;
  /**
   * Optional monthly profit-withdrawal policy. When set to `skim-to-base`,
   * realized equity above the base is pulled out of the account at each UTC
   * month boundary, so working capital — and therefore position sizing —
   * stays anchored to the base instead of compounding. Defaults to no skim.
   */
  readonly withdrawal?: WithdrawalPolicy;
}

export interface ReplayInputs {
  /** All candles, oldest → newest, ANY symbol order. */
  readonly candles: readonly Candle[];
  /** Funding rates (oldest → newest). May be empty. */
  readonly funding?: readonly FundingRate[];
  readonly strategies: readonly StrategyEvaluator[];
  readonly opts: ReplayOptions;
}

export interface ReplayResult {
  readonly trades: readonly Trade[];
  readonly equityCurve: readonly { timestamp: number; equity: number }[];
  readonly finalEquity: number;
  readonly skippedSignals: number;
  readonly blockedByPretrade: number;
  /** Monthly profit skims applied (empty unless a withdrawal policy is set). */
  readonly withdrawals: readonly WithdrawalEvent[];
  /** Sum of all monthly skims — the realized, banked yield. */
  readonly totalWithdrawn: number;
}

/** Run a full backtest. Pure relative to inputs. */
export function runReplay(inputs: ReplayInputs): ReplayResult {
  const opts = inputs.opts;
  const fees = opts.fees ?? {};
  const symbolMeta: Record<TradingSymbol, SymbolMeta> = {
    ...DEFAULT_SYMBOL_META,
    ...(opts.symbolMeta ?? {}),
  };

  const state = createAccountState(opts.startingEquity);
  const trades: Trade[] = [];
  const equityCurve: { timestamp: number; equity: number }[] = [];
  let tradeId = 1;
  let skippedSignals = 0;
  let blockedByPretrade = 0;

  // Group candles by symbol, sorted by openTime.
  const bySymbol = groupCandlesBySymbol(inputs.candles);
  // Index of each symbol's next candle to evaluate.
  const cursor = new Map<TradingSymbol, number>();
  for (const sym of bySymbol.keys()) cursor.set(sym, 0);

  // Per-position bookkeeping the OpenPosition shape doesn't capture.
  const lastFundingApplied = new Map<string, number>(); // positionId → funding ts
  const entryEquity = new Map<string, number>(); // positionId → equity at entry (before entry fee)
  const origStopDistance = new Map<string, number>(); // positionId → |entry-stop| at entry

  // Build the unified timeline: every distinct openTime across all symbols.
  const timeline = uniqueSorted(inputs.candles.map((c) => c.openTime));

  // Sort funding by ts (already sorted typically).
  const fundingSorted = [...(inputs.funding ?? [])].sort((a, b) => a.fundingTime - b.fundingTime);

  // Monthly profit-withdrawal bookkeeping.
  const withdrawalPolicy: WithdrawalPolicy = opts.withdrawal ?? { kind: "none" };
  const withdrawals: WithdrawalEvent[] = [];
  let totalWithdrawn = 0;
  let prevMonthIndex: number | null = null;

  for (const t of timeline) {
    // ── PHASE 0: at each UTC month rollover, skim realized profit above base.
    if (withdrawalPolicy.kind !== "none") {
      const monthIdx = utcMonthIndex(t);
      if (prevMonthIndex !== null && monthIdx !== prevMonthIndex) {
        const before = state.equity;
        const { equity: after, withdrawn } = applySkim(before, withdrawalPolicy);
        if (withdrawn > 0) {
          state.equity = after;
          totalWithdrawn += withdrawn;
          withdrawals.push({
            atUtc: t,
            monthKey: utcMonthKey(t - 1), // label with the month that just ended
            equityBefore: before,
            amountWithdrawn: withdrawn,
            equityAfter: after,
          });
        }
      }
      prevMonthIndex = monthIdx;
    }

    // ── PHASE 1: process exits for any open position whose symbol has a candle at t.
    // We iterate a copy because closures may remove from openPositions.
    const positionsAtT = state.openPositions.filter((p) => {
      const list = bySymbol.get(p.symbol);
      if (!list) return false;
      const idx = cursor.get(p.symbol) ?? 0;
      return list[idx]?.openTime === t;
    });
    for (const position of positionsAtT) {
      const list = bySymbol.get(position.symbol)!;
      const idx = cursor.get(position.symbol)!;
      const candle = list[idx]!;

      // Apply funding payments for any settlements crossed in (lastApplied, t].
      const lastApplied = lastFundingApplied.get(position.id) ?? position.entryTime;
      for (const f of fundingSorted) {
        if (f.symbol !== position.symbol) continue;
        if (f.fundingTime <= lastApplied) continue;
        if (f.fundingTime > t) break;
        const pay = fundingPayment({
          direction: position.direction,
          notionalUsd: position.notionalUsd * (position.remainingQuantity / position.quantity),
          fundingRate: f.fundingRate,
        });
        // pay > 0 means position pays out → reduces P&L (subtract from equity).
        state.equity -= pay;
        // Track on the in-place position record below.
        lastFundingApplied.set(position.id, f.fundingTime);
        // Keep accumulating realizedPnlUsd via mutation below.
        mutatePosition(state, position.id, (p) => ({ ...p, realizedPnlUsd: p.realizedPnlUsd - pay }));
      }

      const exit = simulateExitForCandle(
        {
          direction: position.direction,
          entryPrice: position.entryPrice,
          stopPrice: position.stopPrice,
          tp1Price: position.tp1Price,
          tp2Price: position.tp2Price,
          remainingQuantity: position.remainingQuantity,
          tp1Filled: position.tp1Filled,
          timeStopUtc: position.timeStopUtc,
        },
        candle,
        fees,
      );
      if (exit.kind === "EXIT") {
        const pnlGross =
          (exit.exitPrice - position.entryPrice) *
          exit.closeQuantity *
          (position.direction === "LONG" ? 1 : -1);
        const pnlNet = pnlGross - exit.feePaid;

        if (!exit.fullyClosed) {
          // TP1: 50% close. Update the in-state position to reflect remainder + breakeven stop.
          mutatePosition(state, position.id, (p) => ({
            ...p,
            remainingQuantity: p.remainingQuantity - exit.closeQuantity,
            stopPrice: p.entryPrice, // breakeven move
            tp1Filled: true,
            breakevenMoved: true,
            feesPaidUsd: p.feesPaidUsd + exit.feePaid,
            realizedPnlUsd: p.realizedPnlUsd + pnlNet,
          }));
          state.equity += pnlNet;
        } else {
          // Full close. Build trade journal row, remove position, run circuit-breaker bookkeeping.
          const equityBefore = entryEquity.get(position.id) ?? state.equity;
          const equityAfter = state.equity + pnlNet;
          const totalRealized = equityAfter - equityBefore; // includes entry fee + interim funding
          const totalFees = position.feesPaidUsd + exit.feePaid;
          // R = pnl / initial_risk_dollars (use ORIGINAL stopPrice, not breakeven-bumped one).
          // We track original by storing it on the position.entryPrice + meta; for simplicity
          // here, original stop = position.tp1Price - direction*0 ... no, we lost it on breakeven.
          // The OpenPosition.stopPrice may have been moved to entry on TP1. Use position-original
          // stop distance from when entry was logged: keep `entryPrice - stopPrice` from intent.
          // We re-derive from notional / quantity: not available. Simplest: store on side map.
          const origStopDist = origStopDistance.get(position.id) ?? Math.abs(position.entryPrice - position.stopPrice);
          const initialRiskUsd = origStopDist * position.quantity;
          const pnlR = initialRiskUsd > 0 ? totalRealized / initialRiskUsd : 0;

          const trade: Trade = {
            tradeId: tradeId++,
            mode: position.mode,
            strategy: position.strategy,
            symbol: position.symbol,
            direction: position.direction,
            entryTime: position.entryTime,
            entryPrice: position.entryPrice,
            quantity: position.quantity,
            notionalUsd: position.notionalUsd,
            stopPrice: position.stopPrice,
            tp1Price: position.tp1Price,
            tp2Price: position.tp2Price,
            exitTime: candle.closeTime,
            exitPrice: exit.exitPrice,
            exitReason: exit.exitReason,
            pnlUsd: totalRealized,
            pnlR,
            feesPaid: totalFees,
            accountEquityBefore: equityBefore,
            accountEquityAfter: equityAfter,
          };
          trades.push(trade);
          state.openPositions = state.openPositions.filter((p) => p.id !== position.id);
          lastFundingApplied.delete(position.id);
          recordTradeClose({
            state,
            symbol: position.symbol,
            pnlUsd: pnlNet,
            exitReason: exit.exitReason,
            closeTimeUtc: candle.closeTime,
            ...(opts.circuitBreakers ? { opts: opts.circuitBreakers } : {}),
          });
          // recordTradeClose mutates state.equity += pnlNet on its own; we did not pre-add.
          entryEquity.delete(position.id);
          origStopDistance.delete(position.id);
        }
      }
    }

    // ── PHASE 2: evaluate strategies for each symbol whose candle openTime == t.
    for (const [sym, list] of bySymbol) {
      const idx = cursor.get(sym) ?? 0;
      const candle = list[idx];
      if (!candle || candle.openTime !== t) continue;
      const hasPos = state.openPositions.some((p) => p.symbol === sym);
      const candlesView = list.slice(0, idx + 1); // ≤ T

      for (const strat of inputs.strategies) {
        const intent = strat.evaluate(sym, candlesView, hasPos);
        if (!intent) continue;

        const pre = preTradeChecks({
          state,
          symbol: sym,
          nowUtc: t,
          ...(opts.circuitBreakers ? { opts: opts.circuitBreakers } : {}),
        });
        if (pre.type === "BLOCK") {
          blockedByPretrade++;
          continue;
        }

        const meta = symbolMeta[sym];
        const sized = sizePosition({
          accountEquity: state.equity,
          entryPrice: intent.entryPrice,
          stopPrice: intent.stopPrice,
          openNotionalsSum: state.openPositions.reduce((s, p) => s + p.notionalUsd, 0),
          symbolMeta: meta,
          ...(opts.risk ? { opts: opts.risk } : {}),
        });
        if (sized.type !== "OK") {
          skippedSignals++;
          continue;
        }

        // Apply entry fill (slippage + fee) to the intended entry price.
        const fill = simulateEntryFill(intent.entryPrice, sized.quantity, intent.direction, fees);
        const notionalUsd = fill.entryPrice * sized.quantity;
        const equityAtOpen = state.equity;
        state.equity -= fill.feePaid;

        const id = `${sym}-${t}-${intent.strategy}`;
        const position: OpenPosition = {
          id,
          mode: "backtest",
          strategy: intent.strategy,
          symbol: sym,
          direction: intent.direction,
          entryTime: t,
          entryPrice: fill.entryPrice,
          quantity: sized.quantity,
          remainingQuantity: sized.quantity,
          notionalUsd,
          stopPrice: intent.stopPrice,
          tp1Price: intent.tp1Price,
          tp2Price: intent.tp2Price,
          breakevenTriggerPrice: intent.breakevenTriggerPrice,
          timeStopUtc: intent.timeStopUtc,
          tp1Filled: false,
          breakevenMoved: false,
          feesPaidUsd: fill.feePaid,
          realizedPnlUsd: 0,
        };
        state.openPositions.push(position);
        lastFundingApplied.set(id, position.entryTime);
        entryEquity.set(id, equityAtOpen);
        origStopDistance.set(id, Math.abs(intent.entryPrice - intent.stopPrice));
      }

      // Advance cursor for this symbol.
      cursor.set(sym, idx + 1);
    }

    // Mark-to-market at end of bar.
    let mtm = state.equity;
    for (const p of state.openPositions) {
      const list = bySymbol.get(p.symbol);
      if (!list) continue;
      const lastIdx = (cursor.get(p.symbol) ?? 1) - 1;
      const last = list[lastIdx];
      if (!last) continue;
      const dirSign = p.direction === "LONG" ? 1 : -1;
      mtm += (last.close - p.entryPrice) * p.remainingQuantity * dirSign;
    }
    equityCurve.push({ timestamp: t, equity: mtm });
  }

  return {
    trades,
    equityCurve,
    finalEquity: state.equity,
    skippedSignals,
    blockedByPretrade,
    withdrawals,
    totalWithdrawn,
  };
}

function groupCandlesBySymbol(candles: readonly Candle[]): Map<TradingSymbol, Candle[]> {
  const m = new Map<TradingSymbol, Candle[]>();
  for (const c of candles) {
    const arr = m.get(c.symbol) ?? [];
    arr.push(c);
    m.set(c.symbol, arr);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.openTime - b.openTime);
  return m;
}

function uniqueSorted(xs: readonly number[]): number[] {
  const set = new Set(xs);
  return Array.from(set).sort((a, b) => a - b);
}

function mutatePosition(
  state: { openPositions: OpenPosition[] },
  id: string,
  fn: (p: OpenPosition) => OpenPosition,
): void {
  const idx = state.openPositions.findIndex((p) => p.id === id);
  if (idx >= 0) state.openPositions[idx] = fn(state.openPositions[idx]!);
}

/** Suppress unused-export warnings for a re-exported type. */
export type { ExitReason };
