/**
 * SimulatedExecutionAdapter — backtest-mode {@link ExecutionAdapter}.
 *
 * Spec §9.7. Holds positions/orders/equity in memory, applies the
 * FrictionModel on entry and exit, detects stop/target hits per-bar
 * (longs: low <= stop -> stop, high >= target -> target; shorts mirror;
 * both hit on the same bar -> assume stop first, the conservative choice
 * since intra-bar order is unknown), and persists trades to the DB on
 * close.
 *
 * Order updates produced during `processBar` are returned synchronously
 * AND also drained via subscribeOrderUpdates so live-mode listeners
 * keep working uniformly.
 */

import { randomUUID } from "node:crypto";

import {
  logger,
  type AccountInfo,
  type Bar,
  type CloseContext,
  type Direction,
  type ExecutionAdapter,
  type ExitReason,
  type FrictionUsd,
  type OrderModification,
  type OrderRequest,
  type OrderResult,
  type OrderUpdate,
  type Position,
  type ProcessBarContext,
} from "@trading/core";
import type { Repos } from "@trading/data";

import { AsyncQueue } from "./async-queue.js";
import type { FrictionModel } from "./friction/friction-model.js";

const log = logger("adapters.simulated-execution");

export interface SimulatedExecutionAdapterDeps {
  repos: Repos;
  friction: FrictionModel;
  sessionId: string;
  /** Starting equity in USD. */
  initialEquityUsd: number;
}

interface OpenPositionState {
  position: Position;
  /** Latest mark-to-market price seen via processBar. */
  lastMarkPrice: number;
  /** Last UTC date for which a swap roll has been applied. */
  lastSwapRollDate: string | null;
}

export class SimulatedExecutionAdapter implements ExecutionAdapter {
  private connected = false;
  private equity: number;
  private balance: number;
  private readonly positions = new Map<string, OpenPositionState>();
  private readonly orderUpdates = new AsyncQueue<OrderUpdate>(1024);
  private readonly latestBar = new Map<string, Bar>();
  private latestCtx: ProcessBarContext = { atr14: null, medianAtr14_60d: null };

  constructor(private readonly deps: SimulatedExecutionAdapterDeps) {
    this.equity = deps.initialEquityUsd;
    this.balance = deps.initialEquityUsd;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async start(): Promise<void> {
    this.connected = true;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async stop(): Promise<void> {
    this.connected = false;
    this.orderUpdates.close();
  }

  isConnected(): boolean {
    return this.connected;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getAccountInfo(): Promise<AccountInfo> {
    const openPositions = [...this.positions.values()].map((p) => p.position);
    const unrealized = openPositions.reduce((acc, p) => acc + p.unrealizedPnLUsd, 0);
    const totalRiskPct = openPositions.reduce((acc, p) => acc + p.initialRiskPct, 0);
    return {
      accountId: `backtest-${this.deps.sessionId}`,
      accountType: "backtest",
      currency: "USD",
      equityUsd: this.equity,
      balanceUsd: this.balance,
      marginUsedUsd: 0,
      marginFreeUsd: this.equity,
      openPositionsCount: openPositions.length,
      totalOpenRiskPct: totalRiskPct,
      unrealizedPnlUsd: unrealized,
      unrealizedPnlPct: this.equity === 0 ? 0 : (unrealized / this.equity) * 100,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getOpenPositions(): Promise<Position[]> {
    return [...this.positions.values()].map((p) => p.position);
  }

  async *subscribeOrderUpdates(): AsyncIterable<OrderUpdate> {
    while (true) {
      const update = await this.orderUpdates.next();
      if (update === null) {
        return;
      }
      yield update;
    }
  }

  async submitOrder(order: OrderRequest): Promise<OrderResult> {
    const bar = this.latestBar.get(order.instrument);
    if (bar === undefined) {
      const reject: OrderResult = {
        orderId: randomUUID(),
        clientOrderId: order.clientOrderId,
        status: "rejected",
        fillPrice: null,
        fillTime: null,
        filledLots: 0,
        rejectionReason: "no_bar_seen_yet",
        brokerPositionId: null,
      };
      this.emit({
        orderId: reject.orderId,
        status: reject.status,
        fillPrice: null,
        fillTime: null,
        filledLots: 0,
        rejectionReason: reject.rejectionReason,
        brokerPositionId: null,
      });
      return reject;
    }

    // Reference price for an entry fill: the close of the current bar.
    const rawPrice = order.price ?? bar.close;
    const fill = this.deps.friction.applyFill({
      instrument: order.instrument,
      direction: order.direction,
      orderType: order.orderType,
      rawPrice,
      lotSize: order.lotSize,
      atUtc: bar.timestampUtc,
      atr14: this.latestCtx.atr14,
      medianAtr14_60d: this.latestCtx.medianAtr14_60d,
      side: "entry",
    });

    // Pay entry-side friction immediately (commission + half spread + slippage).
    const entryCost = fill.breakdown.spread + fill.breakdown.slippage + fill.breakdown.commission;
    this.equity -= entryCost;
    this.balance -= entryCost;

    const positionId = randomUUID();
    const brokerOrderId = randomUUID();

    const initialRiskUsd = computeInitialRiskUsd(
      fill.effectivePrice,
      order.stopPrice,
      order.lotSize,
      order.instrument,
    );
    const initialRiskPct =
      this.equity === 0 ? 0 : (initialRiskUsd / this.equity) * 100;

    const position: Position = {
      id: positionId,
      sessionId: this.deps.sessionId,
      originatingSignalId: order.signal.id,
      originatingStrategy: order.originatingStrategy,
      instrument: order.instrument,
      direction: order.direction,
      entryPrice: fill.effectivePrice,
      entryTime: bar.timestampUtc,
      currentStopPrice: order.stopPrice,
      currentTargetPrice: order.targetPrice,
      lotSize: order.lotSize,
      notionalUsd:
        fill.effectivePrice * order.lotSize * standardLotUnitsFor(order.instrument),
      initialRiskPct,
      initialRiskUsd,
      frictionPaidUsd: { ...fill.breakdown },
      unrealizedPnLUsd: 0,
      unrealizedPnLPct: 0,
      brokerOrderId,
      brokerPositionId: positionId,
    };

    this.positions.set(positionId, {
      position,
      lastMarkPrice: fill.effectivePrice,
      lastSwapRollDate: utcDateString(bar.timestampUtc),
    });

    const result: OrderResult = {
      orderId: brokerOrderId,
      clientOrderId: order.clientOrderId,
      status: "filled",
      fillPrice: fill.effectivePrice,
      fillTime: bar.timestampUtc,
      filledLots: order.lotSize,
      rejectionReason: null,
      brokerPositionId: positionId,
    };
    this.emit({
      orderId: brokerOrderId,
      status: "filled",
      fillPrice: fill.effectivePrice,
      fillTime: bar.timestampUtc,
      filledLots: order.lotSize,
      rejectionReason: null,
      brokerPositionId: positionId,
    });
    log.debug(
      {
        positionId,
        instrument: order.instrument,
        direction: order.direction,
        entryPrice: fill.effectivePrice,
        entryCost,
      },
      "position opened",
    );
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async cancelOrder(_orderId: string): Promise<void> {
    // No pending orders in this minimal backtest model — fills are immediate.
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async modifyOrder(orderId: string, updates: OrderModification): Promise<OrderResult> {
    // We only support modify-stop / modify-target on an open position keyed
    // by `orderId == position.id`.
    const state = this.positions.get(orderId);
    if (state === undefined) {
      return {
        orderId,
        clientOrderId: orderId,
        status: "rejected",
        fillPrice: null,
        fillTime: null,
        filledLots: 0,
        rejectionReason: "no_such_position",
        brokerPositionId: null,
      };
    }
    if (updates.stopPrice !== undefined) {
      state.position.currentStopPrice = updates.stopPrice;
    }
    if (updates.targetPrice !== undefined) {
      state.position.currentTargetPrice = updates.targetPrice;
    }
    return {
      orderId,
      clientOrderId: orderId,
      status: "accepted",
      fillPrice: null,
      fillTime: null,
      filledLots: 0,
      rejectionReason: null,
      brokerPositionId: state.position.id,
    };
  }

  async closePosition(positionId: string, ctx?: CloseContext): Promise<OrderResult> {
    const state = this.positions.get(positionId);
    if (state === undefined) {
      return {
        orderId: positionId,
        clientOrderId: positionId,
        status: "rejected",
        fillPrice: null,
        fillTime: null,
        filledLots: 0,
        rejectionReason: "no_such_position",
        brokerPositionId: null,
      };
    }
    const bar = this.latestBar.get(state.position.instrument);
    if (bar === undefined) {
      return {
        orderId: positionId,
        clientOrderId: positionId,
        status: "rejected",
        fillPrice: null,
        fillTime: null,
        filledLots: 0,
        rejectionReason: "no_bar_seen_yet",
        brokerPositionId: null,
      };
    }
    const rawExitPrice = ctx?.atPrice ?? bar.close;
    const reason: ExitReason = ctx?.reason ?? "manual_close";
    return this.realizeClose(state, bar, rawExitPrice, reason);
  }

  async processBar(bar: Bar, ctx?: ProcessBarContext): Promise<OrderUpdate[]> {
    this.latestBar.set(bar.instrument, bar);
    if (ctx !== undefined) {
      this.latestCtx = ctx;
    }
    const generated: OrderUpdate[] = [];

    // Stop/target detection for every open position on this instrument.
    for (const state of [...this.positions.values()]) {
      const p = state.position;
      if (p.instrument !== bar.instrument) {
        continue;
      }
      const hit = detectExit(p, bar);
      if (hit !== null) {
        const result = await this.realizeClose(state, bar, hit.atPrice, hit.reason);
        generated.push({
          orderId: result.orderId,
          status: result.status,
          fillPrice: result.fillPrice,
          fillTime: result.fillTime,
          filledLots: result.filledLots,
          rejectionReason: result.rejectionReason,
          brokerPositionId: result.brokerPositionId,
        });
        continue;
      }
      // Mark-to-market.
      state.lastMarkPrice = bar.close;
      state.position.unrealizedPnLUsd = signedPnlUsd(
        state.position,
        bar.close,
        state.position.entryPrice,
      );
      state.position.unrealizedPnLPct =
        this.equity === 0 ? 0 : (state.position.unrealizedPnLUsd / this.equity) * 100;

      // Swap: apply at most once per UTC day, on the 22:00 rollover.
      const today = utcDateString(bar.timestampUtc);
      if (
        bar.timestampUtc.getUTCHours() >= 22 &&
        today !== state.lastSwapRollDate
      ) {
        const swap = this.deps.friction.swap(
          p.instrument,
          p.direction,
          p.lotSize,
          bar.timestampUtc,
        );
        this.equity += swap;
        this.balance += swap;
        state.position.frictionPaidUsd.swap += -swap; // friction is a cost; record positive
        state.lastSwapRollDate = today;
      }
    }
    return generated;
  }

  // ----------------------------------------------------------- internals

  private emit(update: OrderUpdate): void {
    void this.orderUpdates.push(update);
  }

  private async realizeClose(
    state: OpenPositionState,
    bar: Bar,
    rawExitPrice: number,
    reason: ExitReason,
  ): Promise<OrderResult> {
    const p = state.position;
    // Apply exit-side friction.
    const exit = this.deps.friction.applyFill({
      instrument: p.instrument,
      direction: p.direction,
      orderType: "market",
      rawPrice: rawExitPrice,
      lotSize: p.lotSize,
      atUtc: bar.timestampUtc,
      atr14: this.latestCtx.atr14,
      medianAtr14_60d: this.latestCtx.medianAtr14_60d,
      side: "exit",
    });
    const totalFriction: FrictionUsd = {
      spread: p.frictionPaidUsd.spread + exit.breakdown.spread,
      slippage: p.frictionPaidUsd.slippage + exit.breakdown.slippage,
      commission: p.frictionPaidUsd.commission + exit.breakdown.commission,
      swap: p.frictionPaidUsd.swap,
    };

    // Gross PnL (no exit-side friction yet).
    const grossPnl = signedPnlUsd(p, exit.effectivePrice, p.entryPrice);
    // Exit-side commission + slippage + spread reduce realized PnL.
    const exitCost =
      exit.breakdown.spread + exit.breakdown.slippage + exit.breakdown.commission;
    const realizedPnl = grossPnl - exitCost;
    this.equity += grossPnl - exitCost;
    this.balance += grossPnl - exitCost;

    const realizedPnlPct = this.equity === 0 ? 0 : (realizedPnl / this.equity) * 100;
    const rMultiple = p.initialRiskUsd > 0 ? realizedPnl / p.initialRiskUsd : 0;
    const holdMinutes = Math.max(
      0,
      Math.floor((bar.timestampUtc.getTime() - p.entryTime.getTime()) / 60_000),
    );

    // Persist trade.
    await this.deps.repos.trades.insert({
      sessionId: p.sessionId,
      originatingSignalId: p.originatingSignalId,
      originatingStrategy: p.originatingStrategy,
      instrument: p.instrument,
      direction: p.direction,
      entryPrice: p.entryPrice.toFixed(6),
      exitPrice: exit.effectivePrice.toFixed(6),
      entryTime: p.entryTime,
      exitTime: bar.timestampUtc,
      exitReason: reason,
      lotSize: p.lotSize.toFixed(4),
      notionalUsd: p.notionalUsd.toFixed(2),
      initialRiskPct: p.initialRiskPct.toFixed(4),
      realizedPnlPct: realizedPnlPct.toFixed(4),
      realizedRMultiple: rMultiple.toFixed(4),
      initialRiskUsd: p.initialRiskUsd.toFixed(2),
      realizedPnlUsd: realizedPnl.toFixed(2),
      initialStopPrice: p.currentStopPrice.toFixed(6),
      initialTargetPrice: p.currentTargetPrice.toFixed(6),
      totalFrictionUsd: totalFriction,
      holdDurationMinutes: holdMinutes,
      metadata: { exit_reason: reason, exit_raw_price: rawExitPrice },
    });

    this.positions.delete(p.id);

    const result: OrderResult = {
      orderId: randomUUID(),
      clientOrderId: p.id,
      status: "filled",
      fillPrice: exit.effectivePrice,
      fillTime: bar.timestampUtc,
      filledLots: p.lotSize,
      rejectionReason: null,
      brokerPositionId: p.id,
    };
    this.emit({
      orderId: result.orderId,
      status: result.status,
      fillPrice: result.fillPrice,
      fillTime: result.fillTime,
      filledLots: result.filledLots,
      rejectionReason: null,
      brokerPositionId: p.id,
    });
    log.debug(
      {
        positionId: p.id,
        reason,
        exitPrice: exit.effectivePrice,
        realizedPnl,
        rMultiple,
      },
      "position closed",
    );
    return result;
  }
}

// ----------------------------------------------------------------- helpers

function signedPnlUsd(position: Position, exitPrice: number, entryPrice: number): number {
  const move = exitPrice - entryPrice;
  const signed = position.direction === "long" ? move : -move;
  return signed * position.lotSize * standardLotUnitsFor(position.instrument);
}

function detectExit(
  p: Position,
  bar: Bar,
): { atPrice: number; reason: ExitReason } | null {
  if (p.direction === "long") {
    const stopHit = bar.low <= p.currentStopPrice;
    const targetHit = bar.high >= p.currentTargetPrice;
    // Spec §9.7: both hit -> assume stop first (conservative).
    if (stopHit) {
      return { atPrice: p.currentStopPrice, reason: "stop" };
    }
    if (targetHit) {
      return { atPrice: p.currentTargetPrice, reason: "target" };
    }
    return null;
  }
  // short
  const stopHit = bar.high >= p.currentStopPrice;
  const targetHit = bar.low <= p.currentTargetPrice;
  if (stopHit) {
    return { atPrice: p.currentStopPrice, reason: "stop" };
  }
  if (targetHit) {
    return { atPrice: p.currentTargetPrice, reason: "target" };
  }
  return null;
}

function computeInitialRiskUsd(
  entryPrice: number,
  stopPrice: number,
  lotSize: number,
  instrument: string,
): number {
  const distance = Math.abs(entryPrice - stopPrice);
  return distance * lotSize * standardLotUnitsFor(instrument);
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

function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Re-export shorthand for callers wanting Direction without pulling core. */
export type SimulatedDirection = Direction;
