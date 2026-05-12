/**
 * RiskManager — spec §3.4 + §4.4 + §9.10.
 *
 * All limits expressed as percentages of account equity, so positions
 * scale automatically as the account grows or shrinks.
 *
 * Per-order checks (canExecute):
 *   - riskPerTradePct      : single-order risk vs equity
 *   - maxTotalOpenRiskPct  : new + existing open risk vs equity
 *   - drawdownEmergencyStop: block new entries past the threshold
 *   - dailyLossLimitPct    : block new entries once today's realised
 *                            loss exceeds the configured fraction
 *
 * Halt checks (shouldHalt):
 *   - weeklyHardHaltPct    : halt all trading
 *   - monthlyHardHaltPct
 *   - drawdownEmergencyStopPct
 *
 * Loss tracking happens via `observeClose(realizedPnLUsd, exitTime)` —
 * the engine calls this each time a position closes; the RiskManager
 * tracks rolling day/week/month/peak buckets.
 *
 * Position sizing is exposed separately in ./position-sizing.ts.
 */

import type {
  AccountInfo,
  OrderRequest,
  RiskCheckResult,
  RiskConfig,
  RiskManager as RiskManagerIface,
} from "@trading/core";

import { riskUsdForOrder } from "./position-sizing.js";

export interface RiskManagerOpts {
  config: RiskConfig;
  /** Initial account equity in USD (used as the running peak baseline). */
  initialEquityUsd: number;
}

interface PeriodBucket {
  /** Start instant (UTC) of the bucket. */
  startMs: number;
  /** Running realized PnL inside the bucket (can be positive). */
  pnlUsd: number;
}

export class RiskManager implements RiskManagerIface {
  private peakEquity: number;
  private currentEquity: number;
  private daily: PeriodBucket;
  private weekly: PeriodBucket;
  private monthly: PeriodBucket;

  constructor(private readonly opts: RiskManagerOpts) {
    this.peakEquity = opts.initialEquityUsd;
    this.currentEquity = opts.initialEquityUsd;
    const now = Date.now();
    this.daily = { startMs: utcDayStartMs(now), pnlUsd: 0 };
    this.weekly = { startMs: utcWeekStartMs(now), pnlUsd: 0 };
    this.monthly = { startMs: utcMonthStartMs(now), pnlUsd: 0 };
  }

  canExecute(order: OrderRequest, account: AccountInfo): RiskCheckResult {
    this.currentEquity = account.equityUsd;
    if (account.equityUsd > this.peakEquity) {
      this.peakEquity = account.equityUsd;
    }
    const cfg = this.opts.config;

    // Drawdown emergency stop — block new entries.
    const ddPct = this.drawdownPct();
    if (ddPct > cfg.drawdownEmergencyStopPct) {
      return rejected(
        `drawdown_emergency_stop:${ddPct.toFixed(2)}%>${cfg.drawdownEmergencyStopPct}%`,
      );
    }

    // Per-trade risk.
    const riskUsd = riskUsdForOrder(
      order.instrument,
      order.price ?? order.stopPrice,
      order.stopPrice,
      order.lotSize,
    );
    const riskPct = account.equityUsd === 0 ? 0 : (riskUsd / account.equityUsd) * 100;
    if (riskPct > cfg.riskPerTradePct) {
      return rejected(
        `per_trade_risk:${riskPct.toFixed(3)}%>${cfg.riskPerTradePct}%`,
      );
    }

    // Total open risk (existing + this order).
    const totalRiskPct = account.totalOpenRiskPct + riskPct;
    if (totalRiskPct > cfg.maxTotalOpenRiskPct) {
      return rejected(
        `total_open_risk:${totalRiskPct.toFixed(2)}%>${cfg.maxTotalOpenRiskPct}%`,
      );
    }

    // Daily loss limit (block new entries once breached).
    const dailyLossPct =
      account.equityUsd === 0
        ? 0
        : (-this.daily.pnlUsd / account.equityUsd) * 100;
    if (dailyLossPct > cfg.dailyLossLimitPct) {
      return rejected(
        `daily_loss_limit:${dailyLossPct.toFixed(2)}%>${cfg.dailyLossLimitPct}%`,
      );
    }

    return { allowed: true, reason: null, adjustedLotSize: null };
  }

  shouldHalt(account: AccountInfo): { halt: boolean; reason: string | null } {
    const cfg = this.opts.config;
    this.currentEquity = account.equityUsd;
    if (account.equityUsd > this.peakEquity) {
      this.peakEquity = account.equityUsd;
    }
    const ddPct = this.drawdownPct();
    if (ddPct > cfg.drawdownEmergencyStopPct) {
      return {
        halt: true,
        reason: `drawdown_emergency_stop:${ddPct.toFixed(2)}%>${cfg.drawdownEmergencyStopPct}%`,
      };
    }
    const weeklyLossPct =
      account.equityUsd === 0
        ? 0
        : (-this.weekly.pnlUsd / account.equityUsd) * 100;
    if (weeklyLossPct > cfg.weeklyHardHaltPct) {
      return {
        halt: true,
        reason: `weekly_hard_halt:${weeklyLossPct.toFixed(2)}%>${cfg.weeklyHardHaltPct}%`,
      };
    }
    const monthlyLossPct =
      account.equityUsd === 0
        ? 0
        : (-this.monthly.pnlUsd / account.equityUsd) * 100;
    if (monthlyLossPct > cfg.monthlyHardHaltPct) {
      return {
        halt: true,
        reason: `monthly_hard_halt:${monthlyLossPct.toFixed(2)}%>${cfg.monthlyHardHaltPct}%`,
      };
    }
    return { halt: false, reason: null };
  }

  /**
   * Engine hook — called whenever a position closes. Updates the rolling
   * daily/weekly/monthly buckets, rolling them over when the calendar
   * window advances.
   */
  observeClose(realizedPnLUsd: number, exitTime: Date): void {
    const ms = exitTime.getTime();
    this.rollBuckets(ms);
    this.daily.pnlUsd += realizedPnLUsd;
    this.weekly.pnlUsd += realizedPnLUsd;
    this.monthly.pnlUsd += realizedPnLUsd;
  }

  /** Current drawdown as positive percent (e.g. 12.5 means -12.5%). */
  drawdownPct(): number {
    if (this.peakEquity <= 0) {
      return 0;
    }
    const dd = (this.peakEquity - this.currentEquity) / this.peakEquity;
    return Math.max(0, dd) * 100;
  }

  /** Inspection helpers (used by tests + the UI). */
  get peakEquityUsd(): number {
    return this.peakEquity;
  }
  get dailyPnlUsd(): number {
    return this.daily.pnlUsd;
  }
  get weeklyPnlUsd(): number {
    return this.weekly.pnlUsd;
  }
  get monthlyPnlUsd(): number {
    return this.monthly.pnlUsd;
  }

  // ----------------------------------------------------------- internals

  private rollBuckets(ms: number): void {
    const dayStart = utcDayStartMs(ms);
    if (dayStart !== this.daily.startMs) {
      this.daily = { startMs: dayStart, pnlUsd: 0 };
    }
    const weekStart = utcWeekStartMs(ms);
    if (weekStart !== this.weekly.startMs) {
      this.weekly = { startMs: weekStart, pnlUsd: 0 };
    }
    const monthStart = utcMonthStartMs(ms);
    if (monthStart !== this.monthly.startMs) {
      this.monthly = { startMs: monthStart, pnlUsd: 0 };
    }
  }
}

function rejected(reason: string): RiskCheckResult {
  return { allowed: false, reason, adjustedLotSize: null };
}

function utcDayStartMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** ISO week start (Monday 00:00 UTC). */
function utcWeekStartMs(ms: number): number {
  const d = new Date(ms);
  const dow = d.getUTCDay(); // 0 = Sun .. 6 = Sat
  const daysFromMon = (dow + 6) % 7; // 0 if Mon
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - daysFromMon,
  );
}

function utcMonthStartMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
