/**
 * Runtime config + manual operations (spec §9.19).
 *
 * The `RuntimeOps` class wraps the live TradingSystem with operator
 * controls invoked from the UI (Phase 20-21) or directly via HTTP:
 *
 *   pauseStrategy(name, by, reason)
 *   resumeStrategy(name, by)
 *   killStrategy(name, by, reason)        — stops + closes positions
 *   emergencyStop(by, reason)              — halt + cancel + close all
 *   submitManualOrder(by, order)           — bypasses strategy signals
 *   closeManualPosition(by, positionId)
 *   reloadRiskConfig(by, newConfig)        — hot-reload from config_setting
 *
 * All operations audit-logged with `by` attribution and the appropriate
 * AuditLog helper. Risk checks still apply to manual orders.
 */

import { randomUUID } from "node:crypto";

import {
  logger,
  type ExecutionAdapter,
  type OrderRequest,
  type OrderResult,
  type Position,
  type RiskConfig,
  type Signal,
  type Strategy,
} from "@trading/core";
import type { ConfigSettingRepo } from "@trading/data";
import type { AuditLog, RiskManager } from "@trading/risk";

const log = logger("risk.runtime-ops");

const RISK_CONFIG_KEY = "risk.config";
const EMERGENCY_STOP_DEADLINE_MS = 10_000;

export type StrategyState = "running" | "paused" | "killed";

export interface RuntimeOpsDeps {
  execution: ExecutionAdapter;
  riskManager: RiskManager;
  auditLog: AuditLog;
  configRepo: ConfigSettingRepo;
  /** Strategy registry (name -> instance). */
  strategies: Map<string, Strategy>;
  /** Account-equity provider for risk-check manual orders. */
  accountEquityUsd: () => Promise<number>;
  /** Update the RiskManager's internal config after hot-reload. */
  applyRiskConfig: (cfg: RiskConfig) => void;
}

export interface ManualOrderRequest {
  instrument: string;
  direction: "long" | "short";
  orderType: "market" | "limit" | "stop";
  lotSize: number;
  price: number | null;
  stopPrice: number;
  targetPrice: number;
  reason: string;
}

export interface EmergencyStopReport {
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  withinDeadline: boolean;
  strategiesHalted: string[];
  positionsClosed: number;
  failures: Array<{ scope: string; error: string }>;
}

export class RuntimeOps {
  private readonly strategyState = new Map<string, StrategyState>();

  constructor(private readonly deps: RuntimeOpsDeps) {
    for (const name of deps.strategies.keys()) {
      this.strategyState.set(name, "running");
    }
  }

  /** Snapshot of current strategy states for the UI. */
  states(): Record<string, StrategyState> {
    return Object.fromEntries(this.strategyState.entries());
  }

  /** True if signal-generation should be skipped for a strategy. */
  isPaused(name: string): boolean {
    const s = this.strategyState.get(name);
    return s === "paused" || s === "killed";
  }

  // ---------------------------------------------------------- pause/resume

  async pauseStrategy(name: string, by: string, reason: string): Promise<void> {
    if (!this.deps.strategies.has(name)) {
      throw new Error(`unknown strategy: ${name}`);
    }
    this.strategyState.set(name, "paused");
    await this.deps.auditLog.recordStrategyPaused(name, `${reason} (by ${by})`);
    log.info({ strategy: name, by, reason }, "strategy paused");
  }

  async resumeStrategy(name: string, by: string): Promise<void> {
    if (!this.deps.strategies.has(name)) {
      throw new Error(`unknown strategy: ${name}`);
    }
    if (this.strategyState.get(name) === "killed") {
      throw new Error(`cannot resume killed strategy: ${name}`);
    }
    this.strategyState.set(name, "running");
    await this.deps.auditLog.recordStrategyResumed(name, by);
    log.info({ strategy: name, by }, "strategy resumed");
  }

  async killStrategy(name: string, by: string, reason: string): Promise<number> {
    const strat = this.deps.strategies.get(name);
    if (strat === undefined) {
      throw new Error(`unknown strategy: ${name}`);
    }
    this.strategyState.set(name, "killed");
    let closed = 0;
    for (const pos of strat.getOpenPositions()) {
      try {
        await this.deps.execution.closePosition(pos.id, {
          reason: "manual_close",
        });
        closed += 1;
      } catch (err) {
        log.warn({ err: errMsg(err), pos: pos.id }, "killStrategy: close failed");
      }
    }
    await this.deps.auditLog.recordStrategyKilled(name, `${reason} (by ${by})`);
    log.warn({ strategy: name, by, reason, closed }, "strategy killed");
    return closed;
  }

  // ---------------------------------------------------------- emergency stop

  async emergencyStop(by: string, reason: string): Promise<EmergencyStopReport> {
    const startedAtMs = Date.now();
    const failures: EmergencyStopReport["failures"] = [];

    // Halt every strategy immediately so the next bar produces no signals.
    const haltedNames: string[] = [];
    for (const name of this.deps.strategies.keys()) {
      this.strategyState.set(name, "killed");
      haltedNames.push(name);
    }

    // Close all open positions concurrently with a deadline. Even if a
    // strategy's getOpenPositions hangs we don't block — we go straight
    // to the broker via execution.getOpenPositions().
    let openPositions: Position[] = [];
    try {
      openPositions = await Promise.race([
        this.deps.execution.getOpenPositions(),
        sleep(2_000).then(() => [] as Position[]),
      ]);
    } catch (err) {
      failures.push({ scope: "getOpenPositions", error: errMsg(err) });
    }

    const closes = openPositions.map(async (p) => {
      try {
        await Promise.race([
          this.deps.execution.closePosition(p.id, { reason: "emergency_stop" }),
          sleep(EMERGENCY_STOP_DEADLINE_MS).then(() => {
            throw new Error("close deadline exceeded");
          }),
        ]);
        return true;
      } catch (err) {
        failures.push({ scope: `closePosition:${p.id}`, error: errMsg(err) });
        return false;
      }
    });
    const results = await Promise.all(closes);
    const positionsClosed = results.filter((r) => r).length;

    await this.deps.auditLog.recordEmergencyStop(by, reason);
    const finishedAtMs = Date.now();
    const report: EmergencyStopReport = {
      startedAtMs,
      finishedAtMs,
      durationMs: finishedAtMs - startedAtMs,
      withinDeadline: finishedAtMs - startedAtMs <= EMERGENCY_STOP_DEADLINE_MS,
      strategiesHalted: haltedNames,
      positionsClosed,
      failures,
    };
    log.fatal({ by, reason, report }, "EMERGENCY STOP completed");
    return report;
  }

  // ---------------------------------------------------------- manual orders

  async submitManualOrder(
    by: string,
    req: ManualOrderRequest,
  ): Promise<OrderResult> {
    const equity = await this.deps.accountEquityUsd();
    const synthSignal: Signal = {
      id: randomUUID(),
      originatingStrategy: `manual:${by}`,
      instrument: req.instrument,
      direction: req.direction,
      proposedEntryPrice: req.price ?? 0,
      proposedStopPrice: req.stopPrice,
      proposedTargetPrice: req.targetPrice,
      proposedSizeFractionOfAllocation: 1,
      urgencyScore: 1,
      signalType: "manual",
      entryReason: `manual order by ${by}: ${req.reason}`,
      generatedAtBar: new Date(),
      metadata: { manual: true, by, reason: req.reason },
    };
    const order: OrderRequest = {
      clientOrderId: randomUUID(),
      signal: synthSignal,
      instrument: req.instrument,
      direction: req.direction,
      orderType: req.orderType,
      lotSize: req.lotSize,
      price: req.price,
      stopPrice: req.stopPrice,
      targetPrice: req.targetPrice,
      originatingStrategy: synthSignal.originatingStrategy,
      metadata: { manual: true, by, reason: req.reason },
    };
    // Risk check still applies.
    const account = await this.deps.execution.getAccountInfo();
    const decision = this.deps.riskManager.canExecute(order, account);
    void equity; // available for future user-equity-scaled checks
    if (!decision.allowed) {
      await this.deps.auditLog.recordOrderRejected(
        order,
        decision.reason ?? "risk_gate_rejected",
      );
      return {
        orderId: randomUUID(),
        clientOrderId: order.clientOrderId,
        status: "rejected",
        fillPrice: null,
        fillTime: null,
        filledLots: 0,
        rejectionReason: decision.reason ?? "risk_gate_rejected",
        brokerPositionId: null,
      };
    }
    await this.deps.auditLog.recordManualOrder(by, order);
    return this.deps.execution.submitOrder(order);
  }

  async closeManualPosition(by: string, positionId: string): Promise<OrderResult> {
    await this.deps.auditLog.recordManualClose(by, positionId);
    return this.deps.execution.closePosition(positionId, {
      reason: "manual_close",
    });
  }

  // ---------------------------------------------------------- risk reload

  async reloadRiskConfig(by: string, next: RiskConfig): Promise<void> {
    const prev = await this.deps.configRepo.get(RISK_CONFIG_KEY);
    await this.deps.configRepo.set(
      RISK_CONFIG_KEY,
      next as unknown as Record<string, unknown>,
      by,
    );
    this.deps.applyRiskConfig(next);
    await this.deps.auditLog.recordConfigChange(
      RISK_CONFIG_KEY,
      by,
      prev?.value ?? null,
      next,
    );
    log.info({ by }, "risk config reloaded");
  }

  /** Load the persisted risk config (used at boot to seed the RiskManager). */
  async loadPersistedRiskConfig(): Promise<RiskConfig | null> {
    const row = await this.deps.configRepo.get(RISK_CONFIG_KEY);
    if (row === null) {
      return null;
    }
    return row.value as unknown as RiskConfig;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
