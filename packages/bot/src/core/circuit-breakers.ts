/**
 * Circuit breakers + pre-trade gate per spec §7.
 *
 * Pure functions over `AccountState`. The scheduler/risk pipeline calls
 * `preTradeChecks()` before any order; `recordTradeClose()` updates
 * P&L counters and consecutive-loss tracking after exit.
 *
 * §7.4 pre-trade order:
 *   1. Manual halt
 *   2. Daily P&L ≤ −5%
 *   3. Weekly P&L ≤ −12%
 *   4. Symbol in 12h cooldown
 *   5. Existing position on this symbol
 *   6. Max 3 total positions
 */
import type { AccountState, ExitReason, Symbol as TradingSymbol } from "@hydra/shared";

export const DEFAULT_DAILY_LOSS_CAP_PCT = 5;
export const DEFAULT_WEEKLY_LOSS_CAP_PCT = 12;
export const DEFAULT_CONSECUTIVE_LOSS_THRESHOLD = 3;
export const DEFAULT_COOLDOWN_HOURS = 12;
export const DEFAULT_MAX_OPEN_POSITIONS = 3;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface CircuitBreakerOptions {
  readonly dailyLossCapPct?: number;
  readonly weeklyLossCapPct?: number;
  readonly consecutiveLossThreshold?: number;
  readonly cooldownHours?: number;
  readonly maxOpenPositions?: number;
}

export type PreTradeBlockReason =
  | "MANUAL_HALT"
  | "DAILY_LOSS_CAP"
  | "WEEKLY_LOSS_CAP"
  | "SYMBOL_COOLDOWN"
  | "EXISTING_POSITION"
  | "MAX_POSITIONS";

export interface PreTradeOk {
  readonly type: "OK";
}

export interface PreTradeBlock {
  readonly type: "BLOCK";
  readonly reason: PreTradeBlockReason;
  readonly detail?: string;
}

export type PreTradeResult = PreTradeOk | PreTradeBlock;

export interface PreTradeInputs {
  readonly state: AccountState;
  readonly symbol: TradingSymbol;
  readonly nowUtc: number;
  readonly opts?: CircuitBreakerOptions;
}

/** Run all pre-trade checks in spec order; return first BLOCK or OK. */
export function preTradeChecks(inputs: PreTradeInputs): PreTradeResult {
  const opts = inputs.opts ?? {};
  const dailyCap = opts.dailyLossCapPct ?? DEFAULT_DAILY_LOSS_CAP_PCT;
  const weeklyCap = opts.weeklyLossCapPct ?? DEFAULT_WEEKLY_LOSS_CAP_PCT;
  const maxPositions = opts.maxOpenPositions ?? DEFAULT_MAX_OPEN_POSITIONS;
  const { state, symbol, nowUtc } = inputs;

  if (state.halted) return { type: "BLOCK", reason: "MANUAL_HALT" };

  const dayKey = utcDayKey(nowUtc);
  const dailyPnl = state.dailyPnlByUtcDate.get(dayKey) ?? 0;
  const dailyPnlPct = (dailyPnl / state.startingEquity) * 100;
  if (dailyPnlPct <= -dailyCap) {
    return { type: "BLOCK", reason: "DAILY_LOSS_CAP", detail: dailyPnlPct.toFixed(2) };
  }

  const weekKey = isoWeekKey(nowUtc);
  const weeklyPnl = state.weeklyPnlByIsoWeek.get(weekKey) ?? 0;
  const weeklyPnlPct = (weeklyPnl / state.startingEquity) * 100;
  if (weeklyPnlPct <= -weeklyCap) {
    return { type: "BLOCK", reason: "WEEKLY_LOSS_CAP", detail: weeklyPnlPct.toFixed(2) };
  }

  const cooldownUntil = state.cooldownUntilBySymbol.get(symbol) ?? 0;
  if (cooldownUntil > nowUtc) {
    return { type: "BLOCK", reason: "SYMBOL_COOLDOWN", detail: String(cooldownUntil) };
  }

  if (state.openPositions.some((p) => p.symbol === symbol)) {
    return { type: "BLOCK", reason: "EXISTING_POSITION" };
  }

  if (state.openPositions.length >= maxPositions) {
    return { type: "BLOCK", reason: "MAX_POSITIONS" };
  }

  return { type: "OK" };
}

export interface TradeCloseInputs {
  readonly state: AccountState;
  readonly symbol: TradingSymbol;
  readonly pnlUsd: number;
  readonly exitReason: ExitReason;
  readonly closeTimeUtc: number;
  readonly opts?: CircuitBreakerOptions;
}

/**
 * Mutates `state` to reflect the closed trade:
 *   - equity += pnl
 *   - daily/weekly P&L counters updated
 *   - if exit was a STOP, consecutive losses incremented; otherwise reset
 *   - if consecutive losses ≥ threshold, cooldown applied
 *   - if daily ≤ −cap, weekly ≤ −cap, halts triggered (manual halt for weekly)
 */
export function recordTradeClose(inputs: TradeCloseInputs): void {
  const opts = inputs.opts ?? {};
  const dailyCap = opts.dailyLossCapPct ?? DEFAULT_DAILY_LOSS_CAP_PCT;
  const weeklyCap = opts.weeklyLossCapPct ?? DEFAULT_WEEKLY_LOSS_CAP_PCT;
  const lossThreshold = opts.consecutiveLossThreshold ?? DEFAULT_CONSECUTIVE_LOSS_THRESHOLD;
  const cooldownHours = opts.cooldownHours ?? DEFAULT_COOLDOWN_HOURS;
  const { state, symbol, pnlUsd, exitReason, closeTimeUtc } = inputs;

  state.equity += pnlUsd;
  const dayKey = utcDayKey(closeTimeUtc);
  state.dailyPnlByUtcDate.set(dayKey, (state.dailyPnlByUtcDate.get(dayKey) ?? 0) + pnlUsd);
  const weekKey = isoWeekKey(closeTimeUtc);
  state.weeklyPnlByIsoWeek.set(weekKey, (state.weeklyPnlByIsoWeek.get(weekKey) ?? 0) + pnlUsd);

  if (exitReason === "STOP") {
    const next = (state.consecutiveLossesBySymbol.get(symbol) ?? 0) + 1;
    state.consecutiveLossesBySymbol.set(symbol, next);
    if (next >= lossThreshold) {
      state.cooldownUntilBySymbol.set(symbol, closeTimeUtc + cooldownHours * HOUR_MS);
    }
  } else {
    state.consecutiveLossesBySymbol.set(symbol, 0);
  }

  // Trigger halt on weekly cap; daily cap blocks new entries via preTradeChecks
  // but does NOT halt the system (trade resumption next UTC day is automatic).
  const weeklyPnlPct = ((state.weeklyPnlByIsoWeek.get(weekKey) ?? 0) / state.startingEquity) * 100;
  if (weeklyPnlPct <= -weeklyCap) state.halted = true;

  // Sanity: if dailyCap unused, suppress the unused-var lint.
  void dailyCap;
}

/** YYYY-MM-DD UTC date key. */
export function utcDayKey(epochMs: number): string {
  const d = new Date(epochMs);
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${d.getUTCFullYear()}-${m < 10 ? `0${m}` : m}-${day < 10 ? `0${day}` : day}`;
}

/**
 * ISO 8601 week key (YYYY-Www) where weeks start Monday and the first week of the
 * year is the one containing the first Thursday (equivalently, the week containing
 * January 4). Pure and TZ-free (UTC).
 */
export function isoWeekKey(epochMs: number): string {
  const d = new Date(epochMs);
  const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  // Shift to Thursday of current ISO week (anchors the ISO year).
  const dayNum = (new Date(utcMidnight).getUTCDay() + 6) % 7; // 0 = Mon ... 6 = Sun
  const thursday = new Date(utcMidnight);
  thursday.setUTCDate(thursday.getUTCDate() - dayNum + 3);
  const isoYear = thursday.getUTCFullYear();
  // Thursday of week 1 of isoYear — found by anchoring to Jan 4 (always in week 1).
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
  const week1Thursday = new Date(jan4);
  week1Thursday.setUTCDate(jan4.getUTCDate() - jan4DayNum + 3);
  const week = 1 + Math.round((thursday.getTime() - week1Thursday.getTime()) / (7 * DAY_MS));
  return `${isoYear}-W${week < 10 ? `0${week}` : week}`;
}

/** Construct a fresh AccountState. */
export function createAccountState(startingEquity: number): AccountState {
  return {
    equity: startingEquity,
    startingEquity,
    dailyPnlByUtcDate: new Map(),
    weeklyPnlByIsoWeek: new Map(),
    consecutiveLossesBySymbol: new Map(),
    cooldownUntilBySymbol: new Map(),
    openPositions: [],
    halted: false,
  };
}
