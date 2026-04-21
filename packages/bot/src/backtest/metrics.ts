/**
 * Backtest metrics per spec §8.6.
 *
 * Pure functions that take the trade journal + per-bar equity curve and produce:
 *   - summary metrics (return, Sharpe, max DD, win rate, profit factor, etc.)
 *   - per-month / per-strategy / per-symbol / per-exit-reason breakdowns
 *   - fee drag
 *
 * Annualization assumes 1-hour bars: 365 * 24 = 8760 bars/year. Bar returns
 * are computed from the equity curve, std-dev'd, then scaled by √8760.
 */
import type { ExitReason, StrategyName, Symbol as TradingSymbol, Trade } from "@hydra/shared";

export const BARS_PER_YEAR_HOURLY = 365 * 24;
export const TRADING_DAYS_PER_YEAR = 365;

export interface EquityPoint {
  readonly timestamp: number; // epoch ms
  readonly equity: number;
}

export interface SummaryMetrics {
  readonly startingEquity: number;
  readonly finalEquity: number;
  readonly totalReturnPct: number;
  readonly annualizedReturnPct: number;
  readonly trades: number;
  readonly winRatePct: number;
  readonly profitFactor: number;
  readonly avgWinR: number;
  readonly avgLossR: number;
  readonly expectancyR: number;
  readonly maxDrawdownPct: number;
  readonly maxDrawdownDurationDays: number;
  readonly sharpe: number;
  readonly sortino: number;
  readonly calmar: number;
  readonly totalFeesUsd: number;
  readonly feesAsPctOfGrossPnl: number;
}

export interface MonthlyRow {
  readonly month: string; // YYYY-MM
  readonly startEquity: number;
  readonly endEquity: number;
  readonly returnPct: number;
  readonly trades: number;
  readonly winRatePct: number;
}

export interface SegmentRow {
  readonly key: string;
  readonly trades: number;
  readonly winRatePct: number;
  readonly totalPnlUsd: number;
  readonly expectancyR: number;
  readonly profitFactor: number;
}

export interface ExitReasonRow {
  readonly exitReason: ExitReason;
  readonly count: number;
  readonly pct: number;
}

export interface BacktestReport {
  readonly summary: SummaryMetrics;
  readonly monthly: readonly MonthlyRow[];
  readonly perStrategy: readonly SegmentRow[];
  readonly perSymbol: readonly SegmentRow[];
  readonly exitReasons: readonly ExitReasonRow[];
}

/** Build full report from trades + equity curve. */
export function buildReport(
  trades: readonly Trade[],
  equityCurve: readonly EquityPoint[],
  startingEquity: number,
): BacktestReport {
  const summary = summarize(trades, equityCurve, startingEquity);
  const monthly = monthlyBreakdown(trades, equityCurve, startingEquity);
  const perStrategy = segmentBy(trades, (t) => t.strategy);
  const perSymbol = segmentBy(trades, (t) => t.symbol);
  const exitReasons = exitReasonBreakdown(trades);
  return { summary, monthly, perStrategy, perSymbol, exitReasons };
}

export function summarize(
  trades: readonly Trade[],
  equityCurve: readonly EquityPoint[],
  startingEquity: number,
): SummaryMetrics {
  const finalEquity = equityCurve.length > 0
    ? equityCurve[equityCurve.length - 1]!.equity
    : startingEquity;
  const totalReturnPct = ((finalEquity - startingEquity) / startingEquity) * 100;

  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = losses.reduce((s, t) => s + t.pnlUsd, 0); // negative
  const profitFactor = grossLoss === 0 ? (grossWin > 0 ? Infinity : 0) : grossWin / Math.abs(grossLoss);
  const winRatePct = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const avgWinR = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlR, 0) / wins.length : 0;
  const avgLossR = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlR, 0) / losses.length : 0;
  const expectancyR = trades.length > 0
    ? trades.reduce((s, t) => s + t.pnlR, 0) / trades.length
    : 0;

  const dd = drawdownStats(equityCurve);

  // Sharpe / Sortino from per-bar returns (excluding 0-equity points).
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1]!.equity;
    const curr = equityCurve[i]!.equity;
    if (prev > 0) returns.push((curr - prev) / prev);
  }
  const sharpe = annualizedSharpe(returns);
  const sortino = annualizedSortino(returns);

  // Annualized return: scale total return by (365 days / actual span days).
  const spanMs = equityCurve.length >= 2
    ? equityCurve[equityCurve.length - 1]!.timestamp - equityCurve[0]!.timestamp
    : 0;
  const spanDays = spanMs > 0 ? spanMs / 86_400_000 : 0;
  const annualizedReturnPct = spanDays > 0
    ? ((Math.pow(finalEquity / startingEquity, TRADING_DAYS_PER_YEAR / spanDays) - 1) * 100)
    : 0;

  const calmar = dd.maxDrawdownPct > 0 ? annualizedReturnPct / dd.maxDrawdownPct : 0;
  const totalFeesUsd = trades.reduce((s, t) => s + t.feesPaid, 0);
  const grossPnl = grossWin + Math.abs(grossLoss);
  const feesAsPctOfGrossPnl = grossPnl > 0 ? (totalFeesUsd / grossPnl) * 100 : 0;

  return {
    startingEquity,
    finalEquity,
    totalReturnPct,
    annualizedReturnPct,
    trades: trades.length,
    winRatePct,
    profitFactor,
    avgWinR,
    avgLossR,
    expectancyR,
    maxDrawdownPct: dd.maxDrawdownPct,
    maxDrawdownDurationDays: dd.maxDrawdownDurationDays,
    sharpe,
    sortino,
    calmar,
    totalFeesUsd,
    feesAsPctOfGrossPnl,
  };
}

export function drawdownStats(equityCurve: readonly EquityPoint[]): {
  maxDrawdownPct: number;
  maxDrawdownDurationDays: number;
} {
  if (equityCurve.length === 0) return { maxDrawdownPct: 0, maxDrawdownDurationDays: 0 };
  let peak = equityCurve[0]!.equity;
  let peakTs = equityCurve[0]!.timestamp;
  let maxDDPct = 0;
  let maxDurationMs = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) {
      peak = p.equity;
      peakTs = p.timestamp;
    } else {
      const ddPct = peak > 0 ? ((peak - p.equity) / peak) * 100 : 0;
      if (ddPct > maxDDPct) maxDDPct = ddPct;
      const dur = p.timestamp - peakTs;
      if (dur > maxDurationMs) maxDurationMs = dur;
    }
  }
  return { maxDrawdownPct: maxDDPct, maxDrawdownDurationDays: maxDurationMs / 86_400_000 };
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

function stdev(xs: readonly number[], m = mean(xs)): number {
  if (xs.length < 2) return 0;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export function annualizedSharpe(barReturns: readonly number[]): number {
  if (barReturns.length < 2) return 0;
  const m = mean(barReturns);
  const sd = stdev(barReturns, m);
  if (sd === 0) return 0;
  return (m / sd) * Math.sqrt(BARS_PER_YEAR_HOURLY);
}

export function annualizedSortino(barReturns: readonly number[]): number {
  if (barReturns.length < 2) return 0;
  const m = mean(barReturns);
  const downside = barReturns.filter((x) => x < 0);
  if (downside.length === 0) return 0;
  // Downside deviation: RMS of negative returns vs zero.
  const dd = Math.sqrt(downside.reduce((s, x) => s + x * x, 0) / downside.length);
  if (dd === 0) return 0;
  return (m / dd) * Math.sqrt(BARS_PER_YEAR_HOURLY);
}

function utcMonthKey(epochMs: number): string {
  const d = new Date(epochMs);
  const m = d.getUTCMonth() + 1;
  return `${d.getUTCFullYear()}-${m < 10 ? `0${m}` : m}`;
}

export function monthlyBreakdown(
  trades: readonly Trade[],
  equityCurve: readonly EquityPoint[],
  startingEquity: number,
): MonthlyRow[] {
  if (equityCurve.length === 0) return [];
  // Equity at start of each month: walk equity curve, take first observation in each month.
  const monthFirst = new Map<string, number>();
  const monthLast = new Map<string, number>();
  for (const p of equityCurve) {
    const k = utcMonthKey(p.timestamp);
    if (!monthFirst.has(k)) monthFirst.set(k, p.equity);
    monthLast.set(k, p.equity);
  }
  // Trades per month
  const tradesByMonth = new Map<string, Trade[]>();
  for (const t of trades) {
    const k = utcMonthKey(t.exitTime);
    const arr = tradesByMonth.get(k) ?? [];
    arr.push(t);
    tradesByMonth.set(k, arr);
  }
  // Iterate month keys sorted
  const months = Array.from(new Set([...monthFirst.keys()])).sort();
  const rows: MonthlyRow[] = [];
  let priorEnd = startingEquity;
  for (const m of months) {
    const start = monthFirst.get(m) ?? priorEnd;
    const end = monthLast.get(m) ?? start;
    const ts = tradesByMonth.get(m) ?? [];
    const wins = ts.filter((t) => t.pnlUsd > 0).length;
    rows.push({
      month: m,
      startEquity: start,
      endEquity: end,
      returnPct: start > 0 ? ((end - start) / start) * 100 : 0,
      trades: ts.length,
      winRatePct: ts.length > 0 ? (wins / ts.length) * 100 : 0,
    });
    priorEnd = end;
  }
  return rows;
}

export function segmentBy<K extends string>(
  trades: readonly Trade[],
  keyFn: (t: Trade) => K,
): SegmentRow[] {
  const groups = new Map<K, Trade[]>();
  for (const t of trades) {
    const k = keyFn(t);
    const arr = groups.get(k) ?? [];
    arr.push(t);
    groups.set(k, arr);
  }
  const rows: SegmentRow[] = [];
  for (const [k, ts] of groups) {
    const wins = ts.filter((t) => t.pnlUsd > 0);
    const losses = ts.filter((t) => t.pnlUsd < 0);
    const grossWin = wins.reduce((s, t) => s + t.pnlUsd, 0);
    const grossLoss = losses.reduce((s, t) => s + t.pnlUsd, 0);
    const total = ts.reduce((s, t) => s + t.pnlUsd, 0);
    rows.push({
      key: k,
      trades: ts.length,
      winRatePct: ts.length > 0 ? (wins.length / ts.length) * 100 : 0,
      totalPnlUsd: total,
      expectancyR: ts.length > 0 ? ts.reduce((s, t) => s + t.pnlR, 0) / ts.length : 0,
      profitFactor:
        grossLoss === 0
          ? grossWin > 0
            ? Infinity
            : 0
          : grossWin / Math.abs(grossLoss),
    });
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

export function exitReasonBreakdown(trades: readonly Trade[]): ExitReasonRow[] {
  const counts = new Map<ExitReason, number>();
  for (const t of trades) counts.set(t.exitReason, (counts.get(t.exitReason) ?? 0) + 1);
  const total = trades.length;
  const rows: ExitReasonRow[] = [];
  for (const [reason, count] of counts) {
    rows.push({ exitReason: reason, count, pct: total > 0 ? (count / total) * 100 : 0 });
  }
  return rows.sort((a, b) => b.count - a.count);
}

/** Re-export types used by callers downstream. */
export type { ExitReason, StrategyName, TradingSymbol };
