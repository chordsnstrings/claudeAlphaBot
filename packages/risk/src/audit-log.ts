/**
 * AuditLog — persistent audit trail per spec §9.10 T10.7.
 *
 * Implements the @trading/core AuditLog interface and adds the categorised
 * helpers the spec calls out (recordOrder, recordRiskLimitHit, …). Each
 * helper is a thin wrapper around `recordEvent` so every entry lands in
 * the audit_event table with a consistent (severity, category) shape.
 *
 * Also persists per-signal rows to signal_log via SignalLogRepo so the
 * "did this signal turn into a trade?" question is queryable directly
 * without joining audit_event.
 */

import type {
  AuditLog as AuditLogIface,
  OrderRequest,
  OrderResult,
  Signal,
} from "@trading/core";
import { logger } from "@trading/core";
import type {
  NewAuditEventRow,
  NewSignalLogRow,
  Repos,
} from "@trading/data";

const log = logger("risk.audit-log");

export type AuditCategory =
  | "signal"
  | "order"
  | "trade"
  | "risk"
  | "drawdown"
  | "halt"
  | "strategy"
  | "broker"
  | "reconciliation"
  | "config"
  | "system";

export type Severity = "info" | "warn" | "error" | "fatal";

export class AuditLog implements AuditLogIface {
  constructor(
    private readonly repos: Repos,
    private readonly sessionId: string,
  ) {}

  // -- AuditLog interface --------------------------------------------------

  async recordSignal(args: {
    signal: Signal;
    becameTrade: boolean;
    result?: OrderResult;
    rejectedReason?: string;
  }): Promise<void> {
    // NOTE: became_trade_id is a FK to trade(id). At signal/order time the
    // trade row does not exist yet (it's written when the position CLOSES),
    // and result.brokerPositionId is a POSITION id, not a trade id — so we
    // must NOT set became_trade_id here or we violate the FK. Whether the
    // signal became a trade is recorded via metadata.becameTrade + the
    // absence of rejectedReason; linking to the eventual trade row is a
    // separate post-close UPDATE (future enhancement).
    const row: NewSignalLogRow = {
      sessionId: this.sessionId,
      originatingStrategy: args.signal.originatingStrategy,
      instrument: args.signal.instrument,
      direction: args.signal.direction,
      proposedEntryPrice: args.signal.proposedEntryPrice.toFixed(6),
      proposedStopPrice: args.signal.proposedStopPrice.toFixed(6),
      proposedTargetPrice: args.signal.proposedTargetPrice.toFixed(6),
      proposedSizeFraction: args.signal.proposedSizeFractionOfAllocation.toFixed(4),
      urgencyScore: args.signal.urgencyScore.toFixed(4),
      signalType: args.signal.signalType,
      entryReason: args.signal.entryReason,
      generatedAtBar: args.signal.generatedAtBar,
      metadata: {
        ...args.signal.metadata,
        becameTrade: args.becameTrade,
        brokerPositionId: args.result?.brokerPositionId ?? null,
      },
    };
    if (args.rejectedReason !== undefined) {
      row.rejectedReason = args.rejectedReason;
    }
    await this.repos.signals.insert(row);
  }

  async recordEvent(args: {
    severity: Severity;
    category: string;
    description: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.write(args.severity, args.category, args.description, args.metadata);
  }

  // -- Categorised helpers (spec §9.10 T10.7) ------------------------------

  async recordOrder(order: OrderRequest): Promise<void> {
    await this.write("info", "order", `submit ${order.direction} ${order.instrument}`, {
      lotSize: order.lotSize,
      stopPrice: order.stopPrice,
      targetPrice: order.targetPrice,
      orderType: order.orderType,
    });
  }

  async recordOrderUpdate(orderId: string, status: string, fillPrice?: number | null): Promise<void> {
    await this.write("info", "order", `update ${orderId} -> ${status}`, {
      orderId,
      status,
      fillPrice: fillPrice ?? null,
    });
  }

  async recordTrade(metadata: Record<string, unknown>): Promise<void> {
    await this.write("info", "trade", "trade closed", metadata);
  }

  async recordStrategyPaused(strategy: string, reason: string): Promise<void> {
    await this.write("warn", "strategy", `${strategy} paused: ${reason}`, { strategy });
  }

  async recordStrategyResumed(strategy: string, by: string): Promise<void> {
    await this.write("info", "strategy", `${strategy} resumed`, { strategy, by });
  }

  async recordStrategyKilled(strategy: string, reason: string): Promise<void> {
    await this.write("error", "strategy", `${strategy} killed: ${reason}`, { strategy });
  }

  async recordRiskLimitHit(limit: string, value: number, threshold: number): Promise<void> {
    await this.write("warn", "risk", `${limit} hit: ${value} > ${threshold}`, {
      limit,
      value,
      threshold,
    });
  }

  async recordDrawdownThreshold(threshold: string, ddPct: number): Promise<void> {
    await this.write("warn", "drawdown", `${threshold}: ${ddPct.toFixed(2)}%`, {
      threshold,
      ddPct,
    });
  }

  async recordManualOrder(by: string, order: OrderRequest): Promise<void> {
    await this.write("warn", "order", `manual order by ${by}`, {
      by,
      instrument: order.instrument,
      direction: order.direction,
      lotSize: order.lotSize,
    });
  }

  async recordManualClose(by: string, positionId: string): Promise<void> {
    await this.write("warn", "order", `manual close by ${by}`, { by, positionId });
  }

  async recordEmergencyStop(by: string, reason: string): Promise<void> {
    await this.write("fatal", "halt", `EMERGENCY STOP by ${by}: ${reason}`, {
      by,
      reason,
    });
  }

  async recordConfigChange(key: string, by: string, previous: unknown, next: unknown): Promise<void> {
    await this.write("info", "config", `config ${key} updated by ${by}`, {
      key,
      by,
      previous,
      next,
    });
  }

  async recordBrokerDisconnect(broker: string, reason: string): Promise<void> {
    await this.write("error", "broker", `${broker} disconnected: ${reason}`, { broker });
  }

  async recordBrokerReconnect(broker: string): Promise<void> {
    await this.write("info", "broker", `${broker} reconnected`, { broker });
  }

  async recordSignalRejected(signal: Signal, reason: string): Promise<void> {
    await this.recordSignal({ signal, becameTrade: false, rejectedReason: reason });
  }

  async recordOrderRejected(order: OrderRequest, reason: string): Promise<void> {
    await this.write("warn", "order", `rejected ${order.instrument}: ${reason}`, {
      instrument: order.instrument,
      reason,
    });
  }

  async recordReconciliationMismatch(details: Record<string, unknown>): Promise<void> {
    await this.write("error", "reconciliation", "broker state mismatch", details);
  }

  // -- Query API -----------------------------------------------------------

  async recentEvents(limit = 100): Promise<unknown[]> {
    return this.repos.audit.findBySession(this.sessionId, limit);
  }

  async eventsByCategory(category: string, limit = 100): Promise<unknown[]> {
    const all = await this.repos.audit.findBySession(this.sessionId, 1000);
    return all.filter((e) => e.category === category).slice(0, limit);
  }

  async unacknowledgedEvents(limit = 100): Promise<unknown[]> {
    const all = await this.repos.audit.findBySession(this.sessionId, 1000);
    return all.filter((e) => e.acknowledgedAt === null).slice(0, limit);
  }

  async acknowledgeEvent(id: string): Promise<void> {
    await this.repos.audit.acknowledge(id);
  }

  // -- internals -----------------------------------------------------------

  private async write(
    severity: Severity,
    category: AuditCategory | string,
    description: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const row: NewAuditEventRow = {
      sessionId: this.sessionId,
      severity,
      category,
      description,
    };
    if (metadata !== undefined) {
      row.metadata = metadata;
    }
    try {
      await this.repos.audit.insert(row);
    } catch (err) {
      log.error({ err, severity, category, description }, "audit insert failed");
    }
  }
}
