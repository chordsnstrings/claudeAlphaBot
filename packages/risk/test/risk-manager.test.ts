import { randomUUID } from "node:crypto";

import {
  DEFAULT_RISK_CONFIG,
  type AccountInfo,
  type OrderRequest,
  type Signal,
} from "@trading/core";
import { describe, expect, it } from "vitest";

import { RiskManager } from "../src/risk-manager.js";

function sig(): Signal {
  return {
    id: randomUUID(),
    originatingStrategy: "test",
    instrument: "EURUSD",
    direction: "long",
    proposedEntryPrice: 1.1,
    proposedStopPrice: 1.09,
    proposedTargetPrice: 1.11,
    proposedSizeFractionOfAllocation: 1,
    urgencyScore: 0.5,
    signalType: "test",
    entryReason: "test",
    generatedAtBar: new Date(),
    metadata: {},
  };
}

function order(lotSize: number, stop = 1.09): OrderRequest {
  const s = sig();
  return {
    clientOrderId: randomUUID(),
    signal: s,
    instrument: s.instrument,
    direction: s.direction,
    orderType: "market",
    lotSize,
    price: 1.1,
    stopPrice: stop,
    targetPrice: s.proposedTargetPrice,
    originatingStrategy: s.originatingStrategy,
    metadata: {},
  };
}

function acct(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return {
    accountId: "test",
    accountType: "backtest",
    currency: "USD",
    equityUsd: 100_000,
    balanceUsd: 100_000,
    marginUsedUsd: 0,
    marginFreeUsd: 100_000,
    openPositionsCount: 0,
    totalOpenRiskPct: 0,
    unrealizedPnlUsd: 0,
    unrealizedPnlPct: 0,
    ...overrides,
  };
}

describe("RiskManager.canExecute", () => {
  it("permits an order inside all limits", () => {
    const rm = new RiskManager({
      config: DEFAULT_RISK_CONFIG,
      initialEquityUsd: 100_000,
    });
    // 0.1-lot, 100-pip stop on EURUSD = $100 risk = 0.1% of $100k.
    expect(rm.canExecute(order(0.1), acct()).allowed).toBe(true);
  });

  it("rejects when per-trade risk > riskPerTradePct", () => {
    const rm = new RiskManager({
      config: DEFAULT_RISK_CONFIG, // 1.5% per trade
      initialEquityUsd: 100_000,
    });
    // 1.6-lot, 100-pip stop = $1600 risk = 1.6% > 1.5%.
    const result = rm.canExecute(order(1.6), acct());
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("per_trade_risk");
  });

  it("rejects when total open risk exceeds maxTotalOpenRiskPct", () => {
    const rm = new RiskManager({
      config: DEFAULT_RISK_CONFIG, // 6% max total open
      initialEquityUsd: 100_000,
    });
    // 0.1 lot = 0.1% per-trade; current open risk 5.95% -> 6.05% > 6%.
    const result = rm.canExecute(
      order(0.1),
      acct({ totalOpenRiskPct: 5.95 }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("total_open_risk");
  });

  it("blocks new entries past the drawdown emergency-stop threshold", () => {
    const rm = new RiskManager({
      config: { ...DEFAULT_RISK_CONFIG, drawdownEmergencyStopPct: 20 },
      initialEquityUsd: 100_000,
    });
    // Force drawdown by passing reduced equity.
    const result = rm.canExecute(order(0.1), acct({ equityUsd: 75_000 }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("drawdown_emergency_stop");
  });

  it("blocks new entries once daily loss limit is breached", () => {
    const rm = new RiskManager({
      config: { ...DEFAULT_RISK_CONFIG, dailyLossLimitPct: 4 },
      initialEquityUsd: 100_000,
    });
    // Record a loss > 4% of $100k.
    rm.observeClose(-5000, new Date());
    expect(rm.canExecute(order(0.1), acct()).allowed).toBe(false);
  });
});

describe("RiskManager.shouldHalt", () => {
  it("halts on drawdown emergency stop", () => {
    const rm = new RiskManager({
      config: { ...DEFAULT_RISK_CONFIG, drawdownEmergencyStopPct: 20 },
      initialEquityUsd: 100_000,
    });
    const h = rm.shouldHalt(acct({ equityUsd: 70_000 }));
    expect(h.halt).toBe(true);
    expect(h.reason).toContain("drawdown_emergency_stop");
  });

  it("halts on weekly hard halt", () => {
    const rm = new RiskManager({
      config: { ...DEFAULT_RISK_CONFIG, weeklyHardHaltPct: 12 },
      initialEquityUsd: 100_000,
    });
    rm.observeClose(-15000, new Date()); // -15% weekly loss
    const h = rm.shouldHalt(acct());
    expect(h.halt).toBe(true);
    expect(h.reason).toContain("weekly_hard_halt");
  });
});

describe("RiskManager.observeClose buckets", () => {
  it("daily PnL rolls on a UTC day boundary", () => {
    const rm = new RiskManager({
      config: DEFAULT_RISK_CONFIG,
      initialEquityUsd: 100_000,
    });
    const t1 = new Date("2024-06-01T12:00:00Z");
    const t2 = new Date("2024-06-02T01:00:00Z");
    rm.observeClose(-100, t1);
    expect(rm.dailyPnlUsd).toBe(-100);
    rm.observeClose(-200, t2);
    // New day → daily bucket reset; only -200 counts.
    expect(rm.dailyPnlUsd).toBe(-200);
  });
});
