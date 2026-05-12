/**
 * CTraderExecutionAdapter — live-mode ExecutionAdapter using cTrader Open API.
 *
 * Spec §9.16. PHASE 16 STATE: code only, no actual connection. When the
 * cTrader credentials are missing, `start()` logs and returns; the engine
 * sees `isConnected() === false` and the operator wires real credentials
 * in Phase 18.
 *
 * Message translations (`OrderRequest` -> cTrader Open API):
 *   submitOrder        -> ProtoOANewOrderReq
 *   modifyOrder        -> ProtoOAAmendOrderReq (SL/TP/limit-price update)
 *   cancelOrder        -> ProtoOACancelOrderReq
 *   closePosition      -> ProtoOAClosePositionReq (market close)
 *   getOpenPositions   -> ProtoOAReconcileReq -> positions list
 *   getAccountInfo     -> ProtoOATraderReq -> trader info
 *   subscribeOrderUpdates -> ProtoOAExecutionEvent stream
 *
 * Server-side stops: the engine's order request carries stopPrice +
 * targetPrice; we set them on the broker side at order-create time so
 * a system crash doesn't strand the position.
 */

import { randomUUID } from "node:crypto";

import { CTraderConnection } from "@reiryoku/ctrader-layer";

import {
  logger,
  type AccountInfo,
  type Bar,
  type ExecutionAdapter,
  type OrderModification,
  type OrderRequest,
  type OrderResult,
  type OrderStatus,
  type OrderUpdate,
  type Position,
} from "@trading/core";
import type { Repos } from "@trading/data";
import type { AuditLog } from "@trading/risk";

import { AsyncQueue } from "../async-queue.js";
import type { CTraderCredentials } from "./ctrader-data-feed.js";

const log = logger("adapters.ctrader.execution");

const BACKOFF_SEQUENCE_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];
const STANDARD_LOT_VOLUME = 100_000_00; // cTrader sends volume in 0.01-lot units (centi-lots * 100)

export interface CTraderExecutionAdapterDeps {
  loadCredentials: () => CTraderCredentials | null;
  repos: Repos;
  auditLog: AuditLog;
  symbolIdByName: () => ReadonlyMap<string, number>;
  /** Connection factory; the data feed and execution adapter may share one. */
  connectionFactory?: (host: string, port: number) => CTraderConnection;
}

function hostPort(accountType: "demo" | "live"): { host: string; port: number } {
  if (accountType === "live") {
    return { host: "live.ctraderapi.com", port: 5035 };
  }
  return { host: "demo.ctraderapi.com", port: 5036 };
}

/** Convert lot size (1.0 = 1 standard lot) to cTrader volume integer. */
export function lotsToBrokerVolume(lots: number): number {
  // cTrader Open API: volume integer in 0.01-lot units (== 100 of a
  // standard lot would be 100 * 100_000 = 10_000_000 base units).
  return Math.round(lots * STANDARD_LOT_VOLUME);
}

/** Translate cTrader execution-event status to engine OrderStatus. */
function mapStatus(brokerStatus: string | undefined): OrderStatus {
  switch (brokerStatus) {
    case "ORDER_STATUS_FILLED":
      return "filled";
    case "ORDER_STATUS_ACCEPTED":
      return "accepted";
    case "ORDER_STATUS_PARTIALLY_FILLED":
      return "partially_filled";
    case "ORDER_STATUS_CANCELLED":
      return "cancelled";
    case "ORDER_STATUS_REJECTED":
      return "rejected";
    case "ORDER_STATUS_EXPIRED":
      return "expired";
    default:
      return "submitted";
  }
}

export class CTraderExecutionAdapter implements ExecutionAdapter {
  private connection: CTraderConnection | null = null;
  private connected = false;
  private stopRequested = false;
  private creds: CTraderCredentials | null = null;
  private readonly orderUpdates = new AsyncQueue<OrderUpdate>(1024);
  /** Map clientOrderId -> broker orderId once the order is acked. */
  private readonly clientToBroker = new Map<string, string>();
  /** Map broker orderId -> originating OrderRequest for audit context. */
  private readonly brokerToRequest = new Map<string, OrderRequest>();
  private reconnectAttempt = 0;

  constructor(private readonly deps: CTraderExecutionAdapterDeps) {}

  async start(): Promise<void> {
    const creds = this.deps.loadCredentials();
    if (creds === null) {
      log.info(
        "cTrader credentials not configured — execution adapter idle. Add credentials in Phase 18.",
      );
      await this.deps.auditLog.recordEvent({
        severity: "info",
        category: "broker",
        description: "cTrader execution adapter idle: credentials missing",
      });
      return;
    }
    this.creds = creds;
    await this.connectLoop();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.connection !== null) {
      try {
        this.connection.close();
      } catch (err) {
        log.warn({ err: errMsg(err) }, "error closing cTrader execution connection");
      }
      this.connection = null;
    }
    this.connected = false;
    this.orderUpdates.close();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async *subscribeOrderUpdates(): AsyncIterable<OrderUpdate> {
    while (true) {
      const u = await this.orderUpdates.next();
      if (u === null) {
        return;
      }
      yield u;
    }
  }

  async submitOrder(order: OrderRequest): Promise<OrderResult> {
    if (this.connection === null || !this.connected || this.creds === null) {
      return this.rejectWithoutBroker(order, "execution_adapter_not_connected");
    }
    const symbolId = this.deps.symbolIdByName().get(order.instrument);
    if (symbolId === undefined) {
      return this.rejectWithoutBroker(order, `unknown_symbol:${order.instrument}`);
    }
    const tradeSide = order.direction === "long" ? "BUY" : "SELL";
    const orderType =
      order.orderType === "market"
        ? "MARKET"
        : order.orderType === "limit"
          ? "LIMIT"
          : "STOP";

    // ProtoOANewOrderReq parameters (subset). Server-side SL/TP are
    // attached on creation per spec §7.1 (server-side stops protect
    // against system crash).
    const payload: Record<string, unknown> = {
      ctidTraderAccountId: this.creds.accountId,
      symbolId,
      orderType,
      tradeSide,
      volume: lotsToBrokerVolume(order.lotSize),
      stopLoss: order.stopPrice,
      takeProfit: order.targetPrice,
      clientOrderId: order.clientOrderId,
    };
    if (order.orderType !== "market" && order.price !== null) {
      payload["limitPrice"] = order.price;
      payload["stopPrice"] = order.price;
    }
    try {
      const ack = (await this.connection.sendCommand(
        "ProtoOANewOrderReq",
        payload,
      )) as { order?: { orderId?: number } };
      const brokerOrderId = String(ack.order?.orderId ?? randomUUID());
      this.clientToBroker.set(order.clientOrderId, brokerOrderId);
      this.brokerToRequest.set(brokerOrderId, order);
      await this.persistOrderLog(order, brokerOrderId, "submitted");
      return {
        orderId: brokerOrderId,
        clientOrderId: order.clientOrderId,
        status: "submitted",
        fillPrice: null,
        fillTime: null,
        filledLots: 0,
        rejectionReason: null,
        brokerPositionId: null,
      };
    } catch (err) {
      const reason = errMsg(err);
      await this.deps.auditLog.recordOrderRejected(order, reason);
      return this.rejectWithoutBroker(order, reason);
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (this.connection === null || this.creds === null) {
      return;
    }
    try {
      await this.connection.sendCommand("ProtoOACancelOrderReq", {
        ctidTraderAccountId: this.creds.accountId,
        orderId: Number(orderId),
      });
    } catch (err) {
      log.warn({ err: errMsg(err), orderId }, "cancelOrder failed");
    }
  }

  async modifyOrder(
    orderId: string,
    updates: OrderModification,
  ): Promise<OrderResult> {
    if (this.connection === null || this.creds === null) {
      return this.rejectByOrderId(orderId, "not_connected");
    }
    const payload: Record<string, unknown> = {
      ctidTraderAccountId: this.creds.accountId,
      orderId: Number(orderId),
    };
    if (updates.stopPrice !== undefined) {
      payload["stopLoss"] = updates.stopPrice;
    }
    if (updates.targetPrice !== undefined) {
      payload["takeProfit"] = updates.targetPrice;
    }
    if (updates.price !== undefined) {
      payload["limitPrice"] = updates.price;
    }
    if (updates.lotSize !== undefined) {
      payload["volume"] = lotsToBrokerVolume(updates.lotSize);
    }
    try {
      await this.connection.sendCommand("ProtoOAAmendOrderReq", payload);
      return {
        orderId,
        clientOrderId: orderId,
        status: "accepted",
        fillPrice: null,
        fillTime: null,
        filledLots: 0,
        rejectionReason: null,
        brokerPositionId: null,
      };
    } catch (err) {
      return this.rejectByOrderId(orderId, errMsg(err));
    }
  }

  async closePosition(positionId: string): Promise<OrderResult> {
    if (this.connection === null || this.creds === null) {
      return this.rejectByOrderId(positionId, "not_connected");
    }
    try {
      const result = (await this.connection.sendCommand(
        "ProtoOAClosePositionReq",
        {
          ctidTraderAccountId: this.creds.accountId,
          positionId: Number(positionId),
          volume: 0, // 0 means "close full position"
        },
      )) as { order?: { orderId?: number } };
      return {
        orderId: String(result.order?.orderId ?? randomUUID()),
        clientOrderId: positionId,
        status: "accepted",
        fillPrice: null,
        fillTime: null,
        filledLots: 0,
        rejectionReason: null,
        brokerPositionId: positionId,
      };
    } catch (err) {
      return this.rejectByOrderId(positionId, errMsg(err));
    }
  }

  async getOpenPositions(): Promise<Position[]> {
    if (this.connection === null || this.creds === null) {
      return [];
    }
    try {
      const res = (await this.connection.sendCommand("ProtoOAReconcileReq", {
        ctidTraderAccountId: this.creds.accountId,
      })) as {
        position?: Array<{
          positionId?: number;
          tradeData?: {
            symbolId?: number;
            tradeSide?: "BUY" | "SELL";
            volume?: number;
            openTimestamp?: number | string;
          };
          stopLoss?: number;
          takeProfit?: number;
          price?: number;
        }>;
      };
      const nameById = new Map<number, string>();
      for (const [k, v] of this.deps.symbolIdByName().entries()) {
        nameById.set(v, k);
      }
      const positions: Position[] = [];
      for (const p of res.position ?? []) {
        const symId = p.tradeData?.symbolId;
        if (symId === undefined) {
          continue;
        }
        const instrument = nameById.get(symId);
        if (instrument === undefined) {
          continue;
        }
        positions.push({
          id: String(p.positionId ?? randomUUID()),
          sessionId: "live",
          originatingSignalId: "live",
          originatingStrategy: "live",
          instrument,
          direction: p.tradeData?.tradeSide === "BUY" ? "long" : "short",
          entryPrice: p.price ?? 0,
          entryTime: p.tradeData?.openTimestamp
            ? new Date(Number(p.tradeData.openTimestamp))
            : new Date(),
          currentStopPrice: p.stopLoss ?? 0,
          currentTargetPrice: p.takeProfit ?? 0,
          lotSize: (p.tradeData?.volume ?? 0) / STANDARD_LOT_VOLUME,
          notionalUsd: 0,
          initialRiskPct: 0,
          initialRiskUsd: 0,
          frictionPaidUsd: { spread: 0, slippage: 0, commission: 0, swap: 0 },
          unrealizedPnLUsd: 0,
          unrealizedPnLPct: 0,
          brokerOrderId: null,
          brokerPositionId: String(p.positionId ?? ""),
        });
      }
      return positions;
    } catch (err) {
      log.warn({ err: errMsg(err) }, "ProtoOAReconcileReq failed");
      return [];
    }
  }

  async getAccountInfo(): Promise<AccountInfo> {
    if (this.connection === null || this.creds === null) {
      throw new Error("getAccountInfo: not connected");
    }
    const res = (await this.connection.sendCommand("ProtoOATraderReq", {
      ctidTraderAccountId: this.creds.accountId,
    })) as {
      trader?: {
        balance?: number;
        equity?: number;
        usedMargin?: number;
        freeMargin?: number;
        moneyDigits?: number;
      };
    };
    const t = res.trader ?? {};
    const scale = Math.pow(10, t.moneyDigits ?? 2);
    return {
      accountId: String(this.creds.accountId),
      accountType: this.creds.accountType,
      currency: "USD",
      equityUsd: (t.equity ?? 0) / scale,
      balanceUsd: (t.balance ?? 0) / scale,
      marginUsedUsd: (t.usedMargin ?? 0) / scale,
      marginFreeUsd: (t.freeMargin ?? 0) / scale,
      openPositionsCount: 0,
      totalOpenRiskPct: 0,
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
    };
  }

  /** Optional `notifyBar` is omitted — live mode doesn't need it. */

  // ----------------------------------------------------------- internals

  private async connectLoop(): Promise<void> {
    if (this.creds === null) {
      return;
    }
    while (!this.stopRequested) {
      try {
        await this.connectOnce(this.creds);
        this.reconnectAttempt = 0;
      } catch (err) {
        this.connected = false;
        const waitMs =
          BACKOFF_SEQUENCE_MS[Math.min(this.reconnectAttempt, BACKOFF_SEQUENCE_MS.length - 1)] ??
          60_000;
        this.reconnectAttempt += 1;
        log.warn(
          { err: errMsg(err), attempt: this.reconnectAttempt, waitMs },
          "cTrader execution connect failed; backing off",
        );
        if (this.stopRequested) {
          return;
        }
        await sleep(waitMs);
      }
    }
  }

  private async connectOnce(creds: CTraderCredentials): Promise<void> {
    const { host, port } = hostPort(creds.accountType);
    const factory =
      this.deps.connectionFactory ??
      ((h: string, p: number) => new CTraderConnection({ host: h, port: p }));
    const conn = factory(host, port);
    this.connection = conn;
    await conn.open();

    await conn.sendCommand("ProtoOAApplicationAuthReq", {
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
    });
    await conn.sendCommand("ProtoOAAccountAuthReq", {
      ctidTraderAccountId: creds.accountId,
      accessToken: creds.accessToken,
    });

    conn.on("ProtoOAExecutionEvent", (event) => {
      void this.handleExecutionEvent(event as unknown as ProtoOAExecutionEvent);
    });

    this.connected = true;
    await this.deps.auditLog.recordEvent({
      severity: "info",
      category: "broker",
      description: "cTrader execution connected",
      metadata: { host, port, account: creds.accountId, accountType: creds.accountType },
    });
    await this.waitUntilClosed();
  }

  private waitUntilClosed(): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (this.stopRequested || this.connection === null) {
          clearInterval(check);
          resolve();
        }
      }, 1_000);
    });
  }

  private async handleExecutionEvent(event: ProtoOAExecutionEvent): Promise<void> {
    const status = mapStatus(event.order?.orderStatus);
    const brokerOrderId =
      event.order?.orderId !== undefined ? String(event.order.orderId) : null;
    const fillPrice = event.deal?.executionPrice ?? null;
    const fillTime = event.deal?.executionTimestamp
      ? new Date(Number(event.deal.executionTimestamp))
      : null;
    const filledLots =
      event.deal?.filledVolume !== undefined
        ? event.deal.filledVolume / STANDARD_LOT_VOLUME
        : 0;
    const positionId =
      event.position?.positionId !== undefined ? String(event.position.positionId) : null;

    if (brokerOrderId !== null) {
      await this.deps.auditLog.recordOrderUpdate(brokerOrderId, status, fillPrice);
    }

    const update: OrderUpdate = {
      orderId: brokerOrderId ?? "unknown",
      status,
      fillPrice,
      fillTime,
      filledLots,
      rejectionReason: event.errorCode ?? null,
      brokerPositionId: positionId,
    };
    await this.orderUpdates.push(update);
  }

  private async persistOrderLog(
    order: OrderRequest,
    brokerOrderId: string,
    status: OrderStatus,
  ): Promise<void> {
    try {
      await this.deps.repos.orders.insert({
        sessionId: "live",
        originatingSignalId: order.signal.id,
        orderType: order.orderType,
        instrument: order.instrument,
        direction: order.direction,
        lotSize: order.lotSize.toFixed(4),
        price: order.price !== null ? order.price.toFixed(6) : null,
        brokerOrderId,
        status,
      });
    } catch (err) {
      log.warn({ err: errMsg(err) }, "order_log insert failed");
    }
  }

  private rejectWithoutBroker(order: OrderRequest, reason: string): OrderResult {
    return {
      orderId: randomUUID(),
      clientOrderId: order.clientOrderId,
      status: "rejected",
      fillPrice: null,
      fillTime: null,
      filledLots: 0,
      rejectionReason: reason,
      brokerPositionId: null,
    };
  }

  private rejectByOrderId(orderId: string, reason: string): OrderResult {
    return {
      orderId,
      clientOrderId: orderId,
      status: "rejected",
      fillPrice: null,
      fillTime: null,
      filledLots: 0,
      rejectionReason: reason,
      brokerPositionId: null,
    };
  }
}

interface ProtoOAExecutionEvent {
  order?: {
    orderId?: number;
    orderStatus?: string;
  };
  deal?: {
    executionPrice?: number;
    executionTimestamp?: number | string;
    filledVolume?: number;
  };
  position?: {
    positionId?: number;
  };
  errorCode?: string;
}

/** Re-exported to spare callers an explicit import of @trading/core. */
export type CTraderBar = Bar;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
