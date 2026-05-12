/**
 * AuditLog — persists every signal/order/exception event to the audit_event
 * + signal_log tables. Concrete impl in Phase 10 (wraps the existing
 * AuditEventRepo / SignalLogRepo from Phase 2).
 *
 * Spec §9.5 T5.6.
 */

import type { OrderResult } from "../types/order.js";
import type { Signal } from "../types/signal.js";

export interface AuditLog {
  /**
   * Record a signal. When `becameTrade=true`, `result` is the execution
   * outcome; when `false`, `rejectedReason` explains why (risk gate,
   * orchestrator filter, halt, etc).
   */
  recordSignal(args: {
    signal: Signal;
    becameTrade: boolean;
    result?: OrderResult;
    rejectedReason?: string;
  }): Promise<void>;

  /** Generic categorised event ("system", "halt", "error", "config_change"). */
  recordEvent(args: {
    severity: "info" | "warn" | "error" | "fatal";
    category: string;
    description: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}
