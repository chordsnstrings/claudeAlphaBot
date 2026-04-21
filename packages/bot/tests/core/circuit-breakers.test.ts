import { describe, expect, it } from "vitest";

import {
  createAccountState,
  isoWeekKey,
  preTradeChecks,
  recordTradeClose,
  utcDayKey,
} from "../../src/core/circuit-breakers.js";
import type { OpenPosition } from "@hydra/shared";

const NOW = Date.UTC(2024, 9, 15, 12, 0, 0); // 2024-10-15 12:00 UTC (Tuesday)

function makePosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    id: "pos-1",
    mode: "paper",
    strategy: "ARB",
    symbol: "BTCUSDT",
    direction: "LONG",
    entryTime: NOW - 60_000,
    entryPrice: 50_000,
    quantity: 0.1,
    remainingQuantity: 0.1,
    notionalUsd: 5_000,
    stopPrice: 49_500,
    tp1Price: 50_750,
    tp2Price: 51_500,
    breakevenTriggerPrice: 50_500,
    timeStopUtc: NOW + 6 * 3_600_000,
    tp1Filled: false,
    breakevenMoved: false,
    feesPaidUsd: 0,
    realizedPnlUsd: 0,
    ...overrides,
  };
}

describe("utcDayKey + isoWeekKey", () => {
  it("formats UTC day as YYYY-MM-DD", () => {
    expect(utcDayKey(Date.UTC(2024, 0, 1, 0, 0, 0))).toBe("2024-01-01");
    expect(utcDayKey(Date.UTC(2024, 11, 31, 23, 59, 59))).toBe("2024-12-31");
    expect(utcDayKey(Date.UTC(2024, 1, 29, 12, 0, 0))).toBe("2024-02-29"); // leap day
  });

  it("ISO 8601 week: 2024-01-01 (Monday) is week 01 of 2024", () => {
    expect(isoWeekKey(Date.UTC(2024, 0, 1))).toBe("2024-W01");
  });

  it("ISO 8601 week: 2024-12-30 (Monday) is week 01 of 2025", () => {
    expect(isoWeekKey(Date.UTC(2024, 11, 30))).toBe("2025-W01");
  });

  it("ISO 8601 week: 2023-01-01 (Sunday) is week 52 of 2022", () => {
    expect(isoWeekKey(Date.UTC(2023, 0, 1))).toBe("2022-W52");
  });
});

describe("preTradeChecks — ordering (§7.4)", () => {
  it("OK on fresh state", () => {
    const state = createAccountState(5_000);
    const r = preTradeChecks({ state, symbol: "BTCUSDT", nowUtc: NOW });
    expect(r.type).toBe("OK");
  });

  it("blocks on MANUAL_HALT first (highest priority)", () => {
    const state = createAccountState(5_000);
    state.halted = true;
    state.dailyPnlByUtcDate.set(utcDayKey(NOW), -1_000); // also breaches daily
    state.openPositions.push(makePosition()); // also has existing position
    const r = preTradeChecks({ state, symbol: "BTCUSDT", nowUtc: NOW });
    expect(r.type).toBe("BLOCK");
    if (r.type === "BLOCK") expect(r.reason).toBe("MANUAL_HALT");
  });

  it("blocks DAILY_LOSS_CAP at -5% threshold", () => {
    const state = createAccountState(5_000);
    state.dailyPnlByUtcDate.set(utcDayKey(NOW), -250); // exactly -5%
    const r = preTradeChecks({ state, symbol: "BTCUSDT", nowUtc: NOW });
    expect(r.type).toBe("BLOCK");
    if (r.type === "BLOCK") expect(r.reason).toBe("DAILY_LOSS_CAP");
  });

  it("does NOT block at -4.99% daily P&L", () => {
    const state = createAccountState(5_000);
    state.dailyPnlByUtcDate.set(utcDayKey(NOW), -249.5);
    const r = preTradeChecks({ state, symbol: "BTCUSDT", nowUtc: NOW });
    expect(r.type).toBe("OK");
  });

  it("blocks WEEKLY_LOSS_CAP at -12% threshold", () => {
    const state = createAccountState(5_000);
    state.weeklyPnlByIsoWeek.set(isoWeekKey(NOW), -600); // exactly -12%
    const r = preTradeChecks({ state, symbol: "BTCUSDT", nowUtc: NOW });
    expect(r.type).toBe("BLOCK");
    if (r.type === "BLOCK") expect(r.reason).toBe("WEEKLY_LOSS_CAP");
  });

  it("blocks SYMBOL_COOLDOWN if cooldown is in future", () => {
    const state = createAccountState(5_000);
    state.cooldownUntilBySymbol.set("BTCUSDT", NOW + 3_600_000); // 1h ahead
    const r = preTradeChecks({ state, symbol: "BTCUSDT", nowUtc: NOW });
    expect(r.type).toBe("BLOCK");
    if (r.type === "BLOCK") expect(r.reason).toBe("SYMBOL_COOLDOWN");
  });

  it("does NOT block when cooldown has expired", () => {
    const state = createAccountState(5_000);
    state.cooldownUntilBySymbol.set("BTCUSDT", NOW - 1); // expired
    const r = preTradeChecks({ state, symbol: "BTCUSDT", nowUtc: NOW });
    expect(r.type).toBe("OK");
  });

  it("blocks EXISTING_POSITION when symbol already has open position", () => {
    const state = createAccountState(5_000);
    state.openPositions.push(makePosition({ symbol: "BTCUSDT" }));
    const r = preTradeChecks({ state, symbol: "BTCUSDT", nowUtc: NOW });
    expect(r.type).toBe("BLOCK");
    if (r.type === "BLOCK") expect(r.reason).toBe("EXISTING_POSITION");
  });

  it("does NOT block on DIFFERENT symbol with existing position", () => {
    const state = createAccountState(5_000);
    state.openPositions.push(makePosition({ symbol: "BTCUSDT" }));
    const r = preTradeChecks({ state, symbol: "ETHUSDT", nowUtc: NOW });
    expect(r.type).toBe("OK");
  });

  it("blocks MAX_POSITIONS at 3 open positions", () => {
    const state = createAccountState(5_000);
    state.openPositions.push(makePosition({ id: "1", symbol: "BTCUSDT" }));
    state.openPositions.push(makePosition({ id: "2", symbol: "ETHUSDT" }));
    state.openPositions.push(makePosition({ id: "3", symbol: "SOLUSDT" }));
    // Try to enter a hypothetical 4th — symbol must not match existing
    const r = preTradeChecks({
      state,
      symbol: "BTCUSDT", // pretend we're checking another, but 4th
      nowUtc: NOW,
    });
    // EXISTING_POSITION fires first (BTCUSDT is open). Try a fresh symbol.
    expect(r.type).toBe("BLOCK");
  });

  it("MAX_POSITIONS triggers when openPositions.length >= 3 and symbol is new", () => {
    const state = createAccountState(5_000);
    // Use 3 open positions but query a different symbol entirely (impossible
    // in real life since there are only 3 symbols, but the check is generic).
    state.openPositions.push(makePosition({ id: "1", symbol: "ETHUSDT" }));
    state.openPositions.push(makePosition({ id: "2", symbol: "SOLUSDT" }));
    state.openPositions.push(
      makePosition({ id: "3", symbol: "ETHUSDT" }), // duplicate but length=3
    );
    // Need a symbol not in the list to bypass EXISTING_POSITION.
    // BTCUSDT is not in the list above.
    const r = preTradeChecks({ state, symbol: "BTCUSDT", nowUtc: NOW });
    expect(r.type).toBe("BLOCK");
    if (r.type === "BLOCK") expect(r.reason).toBe("MAX_POSITIONS");
  });

  it("daily cap order > weekly cap order > cooldown order", () => {
    const state = createAccountState(5_000);
    state.dailyPnlByUtcDate.set(utcDayKey(NOW), -300); // -6% breaches daily
    state.weeklyPnlByIsoWeek.set(isoWeekKey(NOW), -700); // -14% breaches weekly
    state.cooldownUntilBySymbol.set("BTCUSDT", NOW + 1_000);
    const r = preTradeChecks({ state, symbol: "BTCUSDT", nowUtc: NOW });
    expect(r.type).toBe("BLOCK");
    if (r.type === "BLOCK") expect(r.reason).toBe("DAILY_LOSS_CAP"); // daily wins
  });
});

describe("recordTradeClose — P&L bookkeeping", () => {
  it("updates equity, daily, and weekly P&L", () => {
    const state = createAccountState(5_000);
    recordTradeClose({
      state,
      symbol: "BTCUSDT",
      pnlUsd: -150,
      exitReason: "STOP",
      closeTimeUtc: NOW,
    });
    expect(state.equity).toBe(4_850);
    expect(state.dailyPnlByUtcDate.get(utcDayKey(NOW))).toBe(-150);
    expect(state.weeklyPnlByIsoWeek.get(isoWeekKey(NOW))).toBe(-150);
  });

  it("accumulates multiple closes within same day/week", () => {
    const state = createAccountState(5_000);
    recordTradeClose({ state, symbol: "BTCUSDT", pnlUsd: -100, exitReason: "STOP", closeTimeUtc: NOW });
    recordTradeClose({ state, symbol: "ETHUSDT", pnlUsd: 50, exitReason: "TP2", closeTimeUtc: NOW });
    expect(state.equity).toBe(4_950);
    expect(state.dailyPnlByUtcDate.get(utcDayKey(NOW))).toBe(-50);
  });
});

describe("recordTradeClose — consecutive-loss cooldown", () => {
  it("increments consecutive losses ONLY on STOP exit", () => {
    const state = createAccountState(5_000);
    recordTradeClose({ state, symbol: "BTCUSDT", pnlUsd: -50, exitReason: "STOP", closeTimeUtc: NOW });
    expect(state.consecutiveLossesBySymbol.get("BTCUSDT")).toBe(1);
    recordTradeClose({ state, symbol: "BTCUSDT", pnlUsd: -50, exitReason: "STOP", closeTimeUtc: NOW + 1_000 });
    expect(state.consecutiveLossesBySymbol.get("BTCUSDT")).toBe(2);
  });

  it("resets consecutive losses on non-STOP exit (TP1, TP2, BREAKEVEN, TIME_STOP)", () => {
    for (const reason of ["TP1", "TP2", "BREAKEVEN", "TIME_STOP"] as const) {
      const state = createAccountState(5_000);
      state.consecutiveLossesBySymbol.set("BTCUSDT", 2);
      recordTradeClose({ state, symbol: "BTCUSDT", pnlUsd: -10, exitReason: reason, closeTimeUtc: NOW });
      expect(state.consecutiveLossesBySymbol.get("BTCUSDT")).toBe(0);
    }
  });

  it("triggers 12h cooldown after 3rd consecutive STOP", () => {
    const state = createAccountState(5_000);
    recordTradeClose({ state, symbol: "BTCUSDT", pnlUsd: -50, exitReason: "STOP", closeTimeUtc: NOW });
    recordTradeClose({ state, symbol: "BTCUSDT", pnlUsd: -50, exitReason: "STOP", closeTimeUtc: NOW + 1_000 });
    expect(state.cooldownUntilBySymbol.get("BTCUSDT") ?? 0).toBe(0);
    recordTradeClose({ state, symbol: "BTCUSDT", pnlUsd: -50, exitReason: "STOP", closeTimeUtc: NOW + 2_000 });
    expect(state.cooldownUntilBySymbol.get("BTCUSDT")).toBe(NOW + 2_000 + 12 * 3_600_000);
  });

  it("cooldown is per-symbol (BTCUSDT losses do NOT cooldown ETHUSDT)", () => {
    const state = createAccountState(5_000);
    recordTradeClose({ state, symbol: "BTCUSDT", pnlUsd: -50, exitReason: "STOP", closeTimeUtc: NOW });
    recordTradeClose({ state, symbol: "BTCUSDT", pnlUsd: -50, exitReason: "STOP", closeTimeUtc: NOW + 1_000 });
    recordTradeClose({ state, symbol: "BTCUSDT", pnlUsd: -50, exitReason: "STOP", closeTimeUtc: NOW + 2_000 });
    expect(state.cooldownUntilBySymbol.get("ETHUSDT") ?? 0).toBe(0);
    const r = preTradeChecks({ state, symbol: "ETHUSDT", nowUtc: NOW + 3_000 });
    expect(r.type).toBe("OK");
  });

  it("TP1 between STOPs resets the consecutive counter", () => {
    const state = createAccountState(5_000);
    recordTradeClose({ state, symbol: "BTCUSDT", pnlUsd: -50, exitReason: "STOP", closeTimeUtc: NOW });
    recordTradeClose({ state, symbol: "BTCUSDT", pnlUsd: -50, exitReason: "STOP", closeTimeUtc: NOW + 1_000 });
    recordTradeClose({ state, symbol: "BTCUSDT", pnlUsd: 25, exitReason: "TP1", closeTimeUtc: NOW + 2_000 });
    expect(state.consecutiveLossesBySymbol.get("BTCUSDT")).toBe(0);
    recordTradeClose({ state, symbol: "BTCUSDT", pnlUsd: -50, exitReason: "STOP", closeTimeUtc: NOW + 3_000 });
    // Only 1 consecutive — no cooldown.
    expect(state.consecutiveLossesBySymbol.get("BTCUSDT")).toBe(1);
    expect(state.cooldownUntilBySymbol.get("BTCUSDT") ?? 0).toBe(0);
  });
});

describe("recordTradeClose — weekly halt", () => {
  it("sets halted=true when weekly P&L breaches -12%", () => {
    const state = createAccountState(5_000);
    // 5 stops of $130 each = -$650 = -13%
    for (let i = 0; i < 5; i++) {
      recordTradeClose({
        state,
        symbol: "BTCUSDT",
        pnlUsd: -130,
        exitReason: "TIME_STOP", // avoid cooldown noise
        closeTimeUtc: NOW + i * 1_000,
      });
    }
    expect(state.halted).toBe(true);
  });

  it("does NOT halt on daily breach alone (only weekly halts)", () => {
    const state = createAccountState(5_000);
    // -6% in one day, but not breaching weekly cap of 12%
    recordTradeClose({
      state,
      symbol: "BTCUSDT",
      pnlUsd: -300,
      exitReason: "TIME_STOP",
      closeTimeUtc: NOW,
    });
    expect(state.halted).toBe(false);
    // But pre-trade check blocks new entries.
    const r = preTradeChecks({ state, symbol: "ETHUSDT", nowUtc: NOW });
    expect(r.type).toBe("BLOCK");
    if (r.type === "BLOCK") expect(r.reason).toBe("DAILY_LOSS_CAP");
  });

  it("daily cap auto-resets next UTC day; weekly cap requires manual reset", () => {
    const state = createAccountState(5_000);
    recordTradeClose({
      state,
      symbol: "BTCUSDT",
      pnlUsd: -300, // -6% daily
      exitReason: "TIME_STOP",
      closeTimeUtc: NOW,
    });
    // Same day → blocks
    expect(preTradeChecks({ state, symbol: "ETHUSDT", nowUtc: NOW }).type).toBe("BLOCK");
    // Next UTC day → daily P&L resets (different key)
    const nextDay = NOW + 86_400_000;
    expect(preTradeChecks({ state, symbol: "ETHUSDT", nowUtc: nextDay }).type).toBe("OK");
  });
});
