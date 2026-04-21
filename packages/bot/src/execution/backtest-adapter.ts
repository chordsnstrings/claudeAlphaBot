/**
 * Backtest execution adapter — wraps the pure fill simulator from
 * `backtest/fill-sim.ts`. Used for offline replays and for testing that
 * the higher-level flow (submitEntry → checkExits → trade row) is
 * consistent across adapters.
 *
 * No external I/O; fully deterministic.
 */
import type {
  BotMode,
  ExitReason,
  OpenPosition,
  SizedSignal,
  Trade,
} from "@hydra/shared";

import {
  simulateEntryFill,
  simulateExitForCandle,
  type FeeOptions,
} from "../backtest/fill-sim.js";

import type {
  CheckExitsInputs,
  EntryResult,
  ExecutionAdapter,
  ExitEvent,
} from "./adapter.js";

export interface BacktestAdapterOptions {
  readonly fees?: FeeOptions;
  readonly mode?: BotMode;
}

export class BacktestAdapter implements ExecutionAdapter {
  readonly mode: BotMode;
  private readonly fees: FeeOptions;
  private tradeId = 1;
  /** positionId → initial risk distance (|entry - stop|) for R calc. */
  private readonly origStopDistance = new Map<string, number>();

  constructor(opts: BacktestAdapterOptions = {}) {
    this.mode = opts.mode ?? "backtest";
    this.fees = opts.fees ?? {};
  }

  async submitEntry(signal: SizedSignal, nowUtc: number): Promise<EntryResult> {
    const fill = simulateEntryFill(
      signal.entryPrice,
      signal.quantity,
      signal.direction,
      this.fees,
    );
    const id = `${signal.symbol}-${nowUtc}-${signal.strategy}`;
    const position: OpenPosition = {
      id,
      mode: this.mode,
      strategy: signal.strategy,
      symbol: signal.symbol,
      direction: signal.direction,
      entryTime: nowUtc,
      entryPrice: fill.entryPrice,
      quantity: signal.quantity,
      remainingQuantity: signal.quantity,
      notionalUsd: fill.entryPrice * signal.quantity,
      stopPrice: signal.stopPrice,
      tp1Price: signal.tp1Price,
      tp2Price: signal.tp2Price,
      breakevenTriggerPrice: signal.breakevenTriggerPrice,
      timeStopUtc: signal.timeStopUtc,
      tp1Filled: false,
      breakevenMoved: false,
      feesPaidUsd: fill.feePaid,
      realizedPnlUsd: 0,
    };
    this.origStopDistance.set(id, Math.abs(signal.entryPrice - signal.stopPrice));
    return { position, feePaid: fill.feePaid };
  }

  async checkExits(inputs: CheckExitsInputs): Promise<readonly ExitEvent[]> {
    const p = inputs.position;
    const decision = simulateExitForCandle(
      {
        direction: p.direction,
        entryPrice: p.entryPrice,
        stopPrice: p.stopPrice,
        tp1Price: p.tp1Price,
        tp2Price: p.tp2Price,
        remainingQuantity: p.remainingQuantity,
        tp1Filled: p.tp1Filled,
        timeStopUtc: p.timeStopUtc,
      },
      inputs.candle,
      this.fees,
    );
    if (decision.kind === "NO_FILL") return [];

    const pnlGross =
      (decision.exitPrice - p.entryPrice) *
      decision.closeQuantity *
      (p.direction === "LONG" ? 1 : -1);
    const pnlNet = pnlGross - decision.feePaid;

    if (!decision.fullyClosed) {
      // TP1 partial: produce an updated position with breakeven-stop applied.
      const updatedPosition: OpenPosition = {
        ...p,
        remainingQuantity: p.remainingQuantity - decision.closeQuantity,
        stopPrice: p.entryPrice,
        tp1Filled: true,
        breakevenMoved: true,
        feesPaidUsd: p.feesPaidUsd + decision.feePaid,
        realizedPnlUsd: p.realizedPnlUsd + pnlNet,
      };
      return [
        {
          exitReason: decision.exitReason,
          exitPrice: decision.exitPrice,
          closeQuantity: decision.closeQuantity,
          feePaid: decision.feePaid,
          fullyClosed: false,
          updatedPosition,
        },
      ];
    }

    const trade = this.buildTradeRow(
      p,
      decision.exitPrice,
      decision.exitReason,
      inputs.candle.closeTime,
      decision.feePaid,
      pnlNet,
      decision.closeQuantity,
      inputs.accountEquityBefore,
    );
    return [
      {
        exitReason: decision.exitReason,
        exitPrice: decision.exitPrice,
        closeQuantity: decision.closeQuantity,
        feePaid: decision.feePaid,
        fullyClosed: true,
        trade,
      },
    ];
  }

  async closePosition(
    position: OpenPosition,
    reason: ExitReason,
    nowUtc: number,
    accountEquityBefore: number,
  ): Promise<ExitEvent> {
    // Emergency close: fill at the position's entry price — the caller is
    // forcing this outside normal exit logic, so we treat slippage + fee as
    // applied against the entry as a safe worst-case.
    const exitPrice = position.entryPrice;
    const feePaid = exitPrice * position.remainingQuantity * 0.0004;
    const pnlGross =
      (exitPrice - position.entryPrice) *
      position.remainingQuantity *
      (position.direction === "LONG" ? 1 : -1);
    const pnlNet = pnlGross - feePaid;
    const trade = this.buildTradeRow(
      position,
      exitPrice,
      reason,
      nowUtc,
      feePaid,
      pnlNet,
      position.remainingQuantity,
      accountEquityBefore,
    );
    return {
      exitReason: reason,
      exitPrice,
      closeQuantity: position.remainingQuantity,
      feePaid,
      fullyClosed: true,
      trade,
    };
  }

  async reconcile(): Promise<readonly OpenPosition[]> {
    // Backtest adapter has no upstream authority. Caller owns state.
    return [];
  }

  async close(): Promise<void> {
    // nothing to tear down
  }

  private buildTradeRow(
    position: OpenPosition,
    exitPrice: number,
    exitReason: ExitReason,
    exitTime: number,
    feePaid: number,
    pnlNet: number,
    closeQuantity: number,
    accountEquityBefore: number,
  ): Trade {
    const origDist =
      this.origStopDistance.get(position.id) ??
      Math.abs(position.entryPrice - position.stopPrice);
    const initialRiskUsd = origDist * position.quantity;
    const totalRealized = position.realizedPnlUsd + pnlNet;
    const pnlR = initialRiskUsd > 0 ? totalRealized / initialRiskUsd : 0;
    this.origStopDistance.delete(position.id);
    const totalFees = position.feesPaidUsd + feePaid;
    return {
      tradeId: this.tradeId++,
      mode: position.mode,
      strategy: position.strategy,
      symbol: position.symbol,
      direction: position.direction,
      entryTime: position.entryTime,
      entryPrice: position.entryPrice,
      quantity: closeQuantity,
      notionalUsd: position.notionalUsd,
      stopPrice: position.stopPrice,
      tp1Price: position.tp1Price,
      tp2Price: position.tp2Price,
      exitTime,
      exitPrice,
      exitReason,
      pnlUsd: totalRealized,
      pnlR,
      feesPaid: totalFees,
      accountEquityBefore,
      accountEquityAfter: accountEquityBefore + pnlNet,
    };
  }
}
