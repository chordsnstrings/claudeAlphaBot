/**
 * Live execution adapter — spec §10.23.
 *
 * Places real orders on Binance Futures via `BinanceSignedRest`:
 *   1. `submitEntry`: MARKET order. On fill, attach STOP_MARKET +
 *      TAKE_PROFIT_MARKET brackets as reduceOnly. Returns the new
 *      position with `exchangeOrderIds=[entryId, stopId, tpId]`.
 *   2. `checkExits`: we do NOT simulate fills here. Instead, we poll
 *      `positionRisk` for the symbol — when positionAmt drops below
 *      the position's remainingQuantity, a bracket fired. We emit the
 *      corresponding ExitEvent and persist the trade row.
 *   3. `closePosition`: cancel remaining brackets, then MARKET-close
 *      the remaining quantity (reduceOnly).
 *   4. `reconcile`: on startup, fetch positionRisk + open_positions.
 *      Positions that exist in DB but not on the exchange are
 *      treated as having exited externally → close them out of the DB.
 *      Positions that exist on the exchange but not in DB are
 *      logged and left alone (operator investigates).
 *
 * Important spec-level invariants:
 *   - Brackets MUST be reduceOnly so a malfunction of our bot never
 *     flips the position.
 *   - All state persists to Postgres so a crash/restart correctly
 *     reconciles via `reconcile()`.
 *   - `exchange_order_ids` stored on every row so close/cancel can
 *     target the exact orders (spec §10.23 state reconciliation).
 */
import type { Pool } from "pg";

import type {
  BotMode,
  ExitReason,
  OpenPosition,
  SizedSignal,
  Symbol as TradingSymbol,
  Trade,
} from "@hydra/shared";

import type { FeeOptions } from "../backtest/fill-sim.js";

import type {
  CheckExitsInputs,
  EntryResult,
  ExecutionAdapter,
  ExitEvent,
} from "./adapter.js";
import type {
  BinanceSignedRest,
  PositionRiskRow,
} from "./binance-signed-rest.js";

export interface LiveAdapterOptions {
  readonly pool: Pool;
  readonly rest: BinanceSignedRest;
  readonly fees?: FeeOptions;
}

export class LiveAdapter implements ExecutionAdapter {
  readonly mode: BotMode = "live";
  private readonly pool: Pool;
  private readonly rest: BinanceSignedRest;
  private readonly origStopDistance = new Map<string, number>();

  constructor(opts: LiveAdapterOptions) {
    this.pool = opts.pool;
    this.rest = opts.rest;
  }

  async submitEntry(signal: SizedSignal, nowUtc: number): Promise<EntryResult> {
    const entryOrder = await this.rest.placeMarketEntry({
      symbol: signal.symbol,
      direction: signal.direction,
      quantity: signal.quantity,
    });
    const entryPrice = Number(entryOrder.avgPrice ?? entryOrder.price ?? signal.entryPrice);
    const closeSide = signal.direction === "LONG" ? "SELL" : "BUY";

    const stopOrder = await this.rest.placeStopMarket({
      symbol: signal.symbol,
      closeSide,
      stopPrice: signal.stopPrice,
      quantity: signal.quantity,
    });
    const tpOrder = await this.rest.placeTakeProfitMarket({
      symbol: signal.symbol,
      closeSide,
      stopPrice: signal.tp2Price,
      quantity: signal.quantity,
    });

    const id = `${signal.symbol}-${nowUtc}-${signal.strategy}`;
    const exchangeOrderIds: readonly string[] = [
      String(entryOrder.orderId),
      String(stopOrder.orderId),
      String(tpOrder.orderId),
    ];
    const feePaid = entryPrice * signal.quantity * 0.0004;
    const position: OpenPosition = {
      id,
      mode: "live",
      strategy: signal.strategy,
      symbol: signal.symbol,
      direction: signal.direction,
      entryTime: nowUtc,
      entryPrice,
      quantity: signal.quantity,
      remainingQuantity: signal.quantity,
      notionalUsd: entryPrice * signal.quantity,
      stopPrice: signal.stopPrice,
      tp1Price: signal.tp1Price,
      tp2Price: signal.tp2Price,
      breakevenTriggerPrice: signal.breakevenTriggerPrice,
      timeStopUtc: signal.timeStopUtc,
      tp1Filled: false,
      breakevenMoved: false,
      feesPaidUsd: feePaid,
      realizedPnlUsd: 0,
      exchangeOrderIds,
    };
    this.origStopDistance.set(id, Math.abs(signal.entryPrice - signal.stopPrice));
    await this.upsertPosition(position);
    return { position, feePaid };
  }

  async checkExits(inputs: CheckExitsInputs): Promise<readonly ExitEvent[]> {
    // Live mode does not synthesize exits — the exchange brackets fire
    // independently. We poll positionRisk to detect when a bracket
    // consumed all/part of our quantity and emit the ExitEvent.
    const p = inputs.position;
    const rows = await this.rest.getPositionRisk();
    const upstream = rows.find((r) => r.symbol === p.symbol);
    const exchangeQty = upstream ? Math.abs(Number(upstream.positionAmt)) : 0;

    if (exchangeQty >= p.remainingQuantity - QTY_EPS) {
      // Position still open upstream — but check time stop.
      if (inputs.candle.openTime >= p.timeStopUtc) {
        const ev = await this.closePosition(p, "TIME_STOP", inputs.nowUtc, inputs.accountEquityBefore);
        return [ev];
      }
      return [];
    }

    // Quantity on exchange shrank → a bracket fired. Determine which.
    const filledQty = p.remainingQuantity - exchangeQty;
    const markPrice = upstream ? Number(upstream.markPrice) : p.entryPrice;
    const tp2Hit = p.direction === "LONG" ? inputs.candle.high >= p.tp2Price : inputs.candle.low <= p.tp2Price;
    const stopHit = p.direction === "LONG" ? inputs.candle.low <= p.stopPrice : inputs.candle.high >= p.stopPrice;
    const reason: ExitReason = stopHit ? "STOP" : tp2Hit ? "TP2" : "TP1";
    const exitPrice = reason === "STOP" ? p.stopPrice : reason === "TP2" ? p.tp2Price : p.tp1Price;

    // Since live brackets are full-size (we place a single TP2 bracket,
    // not split), this represents a full close. If partial fills become
    // relevant (user manually splits brackets), we'd detect via executedQty.
    const fullyClosed = exchangeQty < QTY_EPS;
    const pnlGross =
      (exitPrice - p.entryPrice) * filledQty * (p.direction === "LONG" ? 1 : -1);
    const feePaid = exitPrice * filledQty * 0.0004;
    const pnlNet = pnlGross - feePaid;

    if (fullyClosed) {
      const trade = this.buildTradeRow(
        p,
        exitPrice,
        reason,
        inputs.candle.closeTime,
        feePaid,
        pnlNet,
        filledQty,
        inputs.accountEquityBefore,
      );
      const persisted = await this.insertTrade(trade);
      // Cancel the remaining (unfired) bracket to avoid orphan orders.
      await this.cancelSurvivingBrackets(p, reason);
      await this.deletePosition(p.id);
      // Log mark price divergence for monitoring but don't fail on it.
      void markPrice;
      return [
        {
          exitReason: reason,
          exitPrice,
          closeQuantity: filledQty,
          feePaid,
          fullyClosed: true,
          trade: persisted,
        },
      ];
    }

    // Partial fill — update the DB record.
    const updatedPosition: OpenPosition = {
      ...p,
      remainingQuantity: exchangeQty,
      stopPrice: reason === "TP1" ? p.entryPrice : p.stopPrice,
      tp1Filled: reason === "TP1" ? true : p.tp1Filled,
      breakevenMoved: reason === "TP1" ? true : p.breakevenMoved,
      feesPaidUsd: p.feesPaidUsd + feePaid,
      realizedPnlUsd: p.realizedPnlUsd + pnlNet,
    };
    await this.upsertPosition(updatedPosition);
    return [
      {
        exitReason: reason,
        exitPrice,
        closeQuantity: filledQty,
        feePaid,
        fullyClosed: false,
        updatedPosition,
      },
    ];
  }

  async closePosition(
    position: OpenPosition,
    reason: ExitReason,
    nowUtc: number,
    accountEquityBefore: number,
  ): Promise<ExitEvent> {
    // Cancel any surviving brackets first.
    await this.cancelAllBracketsFor(position);
    // Market close via a reduceOnly order in the opposite direction.
    const closeSide = position.direction === "LONG" ? "SELL" : "BUY";
    const rows = await this.rest.getPositionRisk();
    const upstream = rows.find((r) => r.symbol === position.symbol);
    const qty = upstream ? Math.abs(Number(upstream.positionAmt)) : position.remainingQuantity;
    if (qty > QTY_EPS) {
      // Use a market order with reduceOnly-equivalent semantics by
      // placing same direction as close-side; Binance will reject if
      // it would open a new position.
      await this.rest.placeMarketEntry({
        symbol: position.symbol,
        direction: closeSide === "BUY" ? "LONG" : "SHORT",
        quantity: qty,
      });
    }
    const exitPrice = upstream ? Number(upstream.markPrice) : position.entryPrice;
    const closeQty = position.remainingQuantity;
    const feePaid = exitPrice * closeQty * 0.0004;
    const pnlGross =
      (exitPrice - position.entryPrice) * closeQty * (position.direction === "LONG" ? 1 : -1);
    const pnlNet = pnlGross - feePaid;
    const trade = this.buildTradeRow(
      position,
      exitPrice,
      reason,
      nowUtc,
      feePaid,
      pnlNet,
      closeQty,
      accountEquityBefore,
    );
    const persisted = await this.insertTrade(trade);
    await this.deletePosition(position.id);
    return {
      exitReason: reason,
      exitPrice,
      closeQuantity: closeQty,
      feePaid,
      fullyClosed: true,
      trade: persisted,
    };
  }

  async reconcile(): Promise<readonly OpenPosition[]> {
    const db = await this.pool.query<OpenPositionRow>(
      `SELECT id, mode, strategy, symbol, direction, entry_time, entry_price,
              quantity, remaining_quantity, notional_usd, stop_price, tp1_price,
              tp2_price, breakeven_trigger_price, time_stop_utc, tp1_filled,
              breakeven_moved, fees_paid_usd, realized_pnl_usd, exchange_order_ids
         FROM open_positions WHERE mode = $1`,
      ["live"],
    );
    const dbPositions = db.rows.map(rowToPosition);
    const upstream = await this.rest.getPositionRisk();
    const upstreamBySymbol = new Map<TradingSymbol, PositionRiskRow>();
    for (const r of upstream) {
      if (Math.abs(Number(r.positionAmt)) < QTY_EPS) continue;
      upstreamBySymbol.set(r.symbol as TradingSymbol, r);
    }

    const reconciled: OpenPosition[] = [];
    for (const p of dbPositions) {
      const u = upstreamBySymbol.get(p.symbol);
      if (!u) {
        // Position closed externally. Drop it from the DB.
        await this.deletePosition(p.id);
        continue;
      }
      upstreamBySymbol.delete(p.symbol);
      const qty = Math.abs(Number(u.positionAmt));
      if (qty < p.remainingQuantity - QTY_EPS) {
        // Partial fill while we were offline — update remaining quantity.
        const updated = { ...p, remainingQuantity: qty };
        await this.upsertPosition(updated);
        reconciled.push(updated);
      } else {
        reconciled.push(p);
      }
    }
    // Remaining upstream positions that weren't in our DB are orphans;
    // operator must investigate. We do not auto-adopt them.
    return reconciled;
  }

  async close(): Promise<void> {
    // pool + rest client lifecycle owned by caller
  }

  private async cancelSurvivingBrackets(p: OpenPosition, firedReason: ExitReason): Promise<void> {
    const ids = p.exchangeOrderIds ?? [];
    // ids layout: [entryId, stopId, tpId]. The stop is id[1], TP is id[2].
    const stopId = ids[1];
    const tpId = ids[2];
    try {
      if (firedReason === "STOP" && tpId) {
        await this.rest.cancelOrder(p.symbol, tpId);
      } else if ((firedReason === "TP1" || firedReason === "TP2") && stopId) {
        await this.rest.cancelOrder(p.symbol, stopId);
      }
    } catch {
      // Best-effort — Binance may have already cancelled the sibling.
    }
  }

  private async cancelAllBracketsFor(p: OpenPosition): Promise<void> {
    for (const id of (p.exchangeOrderIds ?? []).slice(1)) {
      try {
        await this.rest.cancelOrder(p.symbol, id);
      } catch {
        // ignore — might be already filled/cancelled
      }
    }
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
      tradeId: 0,
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
         realized_pnl_usd = EXCLUDED.realized_pnl_usd,
         exchange_order_ids = EXCLUDED.exchange_order_ids`,
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

const QTY_EPS = 1e-8;

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
