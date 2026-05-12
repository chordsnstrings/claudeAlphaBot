/**
 * Engine-internal types. Public surface is the TradingSystem class +
 * buildSystem; everything else is implementation detail.
 */

import type {
  AuditLog,
  Bar,
  Clock,
  ExecutionAdapter,
  MarketDataFeed,
  MetricsCollector,
  Orchestrator,
  RiskManager,
  Strategy,
  Timeframe,
} from "@trading/core";

export interface TradingSystemDeps {
  dataFeed: MarketDataFeed;
  execution: ExecutionAdapter;
  clock: Clock;
  strategies: Strategy[];
  orchestrator: Orchestrator;
  riskManager: RiskManager;
  metrics: MetricsCollector;
  auditLog: AuditLog;
  sessionId: string;
  /** Mode is recorded for telemetry only; the system never branches on it. */
  mode: "backtest" | "live";
  /** Instruments + timeframes to subscribe to. */
  subscriptions: Array<{ instrument: string; timeframe: Timeframe }>;
  /**
   * Trailing bar buffer size for indicator computation. Spec §5.1 calls for
   * ~500 bars (enough for 200-period SMA + 252-bar pastReturn).
   */
  recentBarsWindow?: number;
}

export interface PerBarStats {
  instrument: string;
  timeframe: Timeframe;
  timestampUtc: Date;
  signalsThisBar: number;
  ordersThisBar: number;
  ordersRejected: number;
  ordersExecuted: number;
}

export type BarKey = `${string}|${Timeframe}`;

export function barKey(instrument: string, timeframe: Timeframe): BarKey {
  return `${instrument}|${timeframe}`;
}

export function isCompleteBar(b: Bar): boolean {
  return Number.isFinite(b.open) && Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.close);
}
