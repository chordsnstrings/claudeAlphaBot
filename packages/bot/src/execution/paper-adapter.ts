/**
 * Paper-trading execution adapter — spec §10.22.
 *
 * Operates identically to the backtest adapter in terms of fill logic
 * (slippage + taker fee applied to the intended price), but:
 *   1. Runs against live streaming candles from `BinanceWsClient`
 *      (the runtime wires that stream in; the adapter does not open
 *      its own socket — that's the scheduler's responsibility in
 *      Phase 14).
 *   2. Persists trade rows to the `trades` table with `mode='paper'`
 *      so a long-running paper deployment leaves an auditable record.
 *   3. Upserts position state into `open_positions` so crash-restart
 *      can reconcile without losing in-flight positions.
 *
 * The caller is expected to feed candles in `checkExits` — the adapter
 * does NOT subscribe directly. This keeps the decision/execution split
 * identical across all three modes.
 */
import type { Pool } from "pg";

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

export interface PaperAdapterOptions {
  readonly pool: Pool;
  readonly fees?: FeeOptions;
}

export class PaperAdapter implements ExecutionAdapter {
  readonly mode: BotMode = "paper";
  private readonly pool: Pool;
  private readonly fees: FeeOptions;
  private readonly origStopDistance = new Map<string, number>();

  constructor(opts: PaperAdapterOptions) {
    this.pool = opts.pool;
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
      mode: "paper",
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
    await this.upsertPosition(position);
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
      const updatedPosition: OpenPosition = {
        ...p,
        remainingQuantity: p.remainingQuantity - decision.closeQuantity,
        stopPrice: p.entryPrice,
        tp1Filled: true,
        breakevenMoved: true,
        feesPaidUsd: p.feesPaidUsd + decision.feePaid,
        realizedPnlUsd: p.realizedPnlUsd + pnlNet,
      };
      await this.upsertPosition(updatedPosition);
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
    const persistedTrade = await this.insertTrade(trade);
    await this.deletePosition(p.id);
    return [
      {
        exitReason: decision.exitReason,
        exitPrice: decision.exitPrice,
        closeQuantity: decision.closeQuantity,
        feePaid: decision.feePaid,
        fullyClosed: true,
        trade: persistedTrade,
      },
    ];
  }

  async closePosition(
    position: OpenPosition,
    reason: ExitReason,
    nowUtc: number,
    accountEquityBefore: number,
  ): Promise<ExitEvent> {
    const exitPrice = position.entryPrice;
    const feePaid = exitPrice * position.remainingQuantity * 0.0004;
    const pnlNet = -feePaid;
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
    const persistedTrade = await this.insertTrade(trade);
    await this.deletePosition(position.id);
    return {
      exitReason: reason,
      exitPrice,
      closeQuantity: position.remainingQuantity,
      feePaid,
      fullyClosed: true,
      trade: persistedTrade,
    };
  }

  async reconcile(): Promise<readonly OpenPosition[]> {
    const res = await this.pool.query<OpenPositionRow>(
      `SELECT id, mode, strategy, symbol, direction, entry_time, entry_price,
              quantity, remaining_quantity, notional_usd, stop_price, tp1_price,
              tp2_price, breakeven_trigger_price, time_stop_utc, tp1_filled,
              breakeven_moved, fees_paid_usd, realized_pnl_usd, exchange_order_ids
         FROM open_positions WHERE mode = $1`,
      ["paper"],
    );
    return res.rows.map(rowToPosition);
  }

  async close(): Promise<void> {
    // pool lifecycle is owned by the caller
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
    return {
      tradeId: 0, // filled by DB BIGSERIAL
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
      feesPaid: position.feesPaidUsd + feePaid,
      accountEquityBefore,
      accountEquityAfter: accountEquityBefore + pnlNet,
    };
  }

  private async upsertPosition(p: OpenPosition): Promise<void> {
    await this.pool.query(
      `INSERT INTO open_positions (
         id, mode, strategy, symbol, direction, entry_time, entry_price,
         quantity, remaining_quantity, notional_usd, stop_price, tp1_price,
         tp2_price, breakeven_trigger_price, time_stop_utc, tp1_filled,
         breakeven_moved, fees_paid_usd, realized_pnl_usd, exchange_order_ids
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (id) DO UPDATE SET
         remaining_quantity = EXCLUDED.remaining_quantity,
         stop_price = EXCLUDED.stop_price,
         tp1_filled = EXCLUDED.tp1_filled,
         breakeven_moved = EXCLUDED.breakeven_moved,
         fees_paid_usd = EXCLUDED.fees_paid_usd,
         realized_pnl_usd = EXCLUDED.realized_pnl_usd`,
      [
        p.id, p.mode, p.strategy, p.symbol, p.direction, p.entryTime, p.entryPrice,
        p.quantity, p.remainingQuantity, p.notionalUsd, p.stopPrice, p.tp1Price,
        p.tp2Price, p.breakevenTriggerPrice, p.timeStopUtc, p.tp1Filled,
        p.breakevenMoved, p.feesPaidUsd, p.realizedPnlUsd,
        p.exchangeOrderIds ? JSON.stringify(p.exchangeOrderIds) : null,
      ],
    );
  }

  private async deletePosition(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM open_positions WHERE id = $1`, [id]);
  }

  private async insertTrade(t: Trade): Promise<Trade> {
    const res = await this.pool.query<{ trade_id: number }>(
      `INSERT INTO trades (
         mode, strategy, symbol, direction, entry_time, entry_price, quantity,
         notional_usd, stop_price, tp1_price, tp2_price, exit_time, exit_price,
         exit_reason, pnl_usd, pnl_r, fees_paid, account_equity_before,
         account_equity_after
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING trade_id`,
      [
        t.mode, t.strategy, t.symbol, t.direction, t.entryTime, t.entryPrice,
        t.quantity, t.notionalUsd, t.stopPrice, t.tp1Price, t.tp2Price,
        t.exitTime, t.exitPrice, t.exitReason, t.pnlUsd, t.pnlR, t.feesPaid,
        t.accountEquityBefore, t.accountEquityAfter,
      ],
    );
    return { ...t, tradeId: res.rows[0]?.trade_id ?? 0 };
  }
}

interface OpenPositionRow {
  readonly id: string;
  readonly mode: BotMode;
  readonly strategy: string;
  readonly symbol: string;
  readonly direction: string;
  readonly entry_time: string;
  readonly entry_price: string;
  readonly quantity: string;
  readonly remaining_quantity: string;
  readonly notional_usd: string;
  readonly stop_price: string;
  readonly tp1_price: string;
  readonly tp2_price: string;
  readonly breakeven_trigger_price: string;
  readonly time_stop_utc: string;
  readonly tp1_filled: boolean;
  readonly breakeven_moved: boolean;
  readonly fees_paid_usd: string;
  readonly realized_pnl_usd: string;
  readonly exchange_order_ids: string | null;
}

function rowToPosition(r: OpenPositionRow): OpenPosition {
  const exchangeIds = r.exchange_order_ids
    ? (JSON.parse(r.exchange_order_ids) as readonly string[])
    : undefined;
  return {
    id: r.id,
    mode: r.mode,
    strategy: r.strategy as OpenPosition["strategy"],
    symbol: r.symbol as OpenPosition["symbol"],
    direction: r.direction as OpenPosition["direction"],
    entryTime: Number(r.entry_time),
    entryPrice: Number(r.entry_price),
    quantity: Number(r.quantity),
    remainingQuantity: Number(r.remaining_quantity),
    notionalUsd: Number(r.notional_usd),
    stopPrice: Number(r.stop_price),
    tp1Price: Number(r.tp1_price),
    tp2Price: Number(r.tp2_price),
    breakevenTriggerPrice: Number(r.breakeven_trigger_price),
    timeStopUtc: Number(r.time_stop_utc),
    tp1Filled: r.tp1_filled,
    breakevenMoved: r.breakeven_moved,
    feesPaidUsd: Number(r.fees_paid_usd),
    realizedPnlUsd: Number(r.realized_pnl_usd),
    ...(exchangeIds ? { exchangeOrderIds: exchangeIds } : {}),
  };
}
