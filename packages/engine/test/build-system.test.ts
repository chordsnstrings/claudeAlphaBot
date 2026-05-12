import { describe, expect, it } from "vitest";

import { type SystemConfig } from "@trading/core";

import { buildSystem, registerAdapters } from "../src/build-system.js";

function baseBacktestConfig(): SystemConfig {
  return {
    sessionId: "00000000-0000-0000-0000-000000000000",
    mode: "backtest",
    database: { connectionString: "postgres://x:y@h/d", poolSize: 1 },
    backtest: {
      startDate: new Date("2025-01-01T00:00:00Z"),
      endDate: new Date("2026-01-01T00:00:00Z"),
      instruments: ["EURUSD"],
      timeframes: ["d1"],
      initialEquityUsd: 100_000,
      frictionProfile: "zero_friction",
      randomSeed: 1n,
    },
    live: null,
    strategies: [],
    orchestratorMode: "equal_weight",
    riskConfig: {
      riskPerTradePct: 1.5,
      maxTotalOpenRiskPct: 6,
      maxCorrelatedClusterPct: 4,
      maxMarginUtilizationPct: 25,
      dailyLossLimitPct: 4,
      weeklySoftAlertPct: 6,
      weeklyHardHaltPct: 12,
      monthlySoftAlertPct: 8,
      monthlyHardHaltPct: 15,
      drawdownSoftReducePct: 10,
      drawdownEmergencyStopPct: 20,
      drawdownRebuildRequiredPct: 25,
    },
    logLevel: "info",
    codeVersion: "test",
  };
}

describe("buildSystem", () => {
  it("throws with a phase-pointing message when no backtest factory is registered", async () => {
    // Reset by registering empty factories that throw on call.
    registerAdapters({});
    await expect(buildSystem(baseBacktestConfig())).rejects.toThrow(
      /Phase 6.*Phase 7.*Phase 8/u,
    );
  });

  it("delegates to the registered backtest factory and returns a TradingSystem", async () => {
    let factoryCalled = false;
    registerAdapters({
      buildBacktest: async (cfg) => {
        factoryCalled = true;
        expect(cfg.mode).toBe("backtest");
        return {
          dataFeed: {
            // eslint-disable-next-line @typescript-eslint/require-await
            async start() {},
            // eslint-disable-next-line @typescript-eslint/require-await
            async stop() {},
            isConnected: () => false,
            getCurrentBar: () => null,
            // eslint-disable-next-line @typescript-eslint/require-await
            async getHistoricalBars() {
              return [];
            },
            // eslint-disable-next-line @typescript-eslint/require-await, require-yield
            async *subscribe() {},
          },
          execution: {
            // eslint-disable-next-line @typescript-eslint/require-await
            async start() {},
            // eslint-disable-next-line @typescript-eslint/require-await
            async stop() {},
            isConnected: () => false,
            // eslint-disable-next-line @typescript-eslint/require-await
            async submitOrder() {
              throw new Error("not used");
            },
            // eslint-disable-next-line @typescript-eslint/require-await
            async cancelOrder() {},
            // eslint-disable-next-line @typescript-eslint/require-await
            async modifyOrder() {
              throw new Error("not used");
            },
            // eslint-disable-next-line @typescript-eslint/require-await
            async closePosition() {
              throw new Error("not used");
            },
            // eslint-disable-next-line @typescript-eslint/require-await
            async getOpenPositions() {
              return [];
            },
            // eslint-disable-next-line @typescript-eslint/require-await
            async getAccountInfo() {
              throw new Error("not used in this test");
            },
            // eslint-disable-next-line @typescript-eslint/require-await, require-yield
            async *subscribeOrderUpdates() {},
          },
          clock: { now: () => new Date(), sleep: async () => {} },
          strategies: [],
          orchestrator: { process: () => [] },
          riskManager: {
            canExecute: () => ({ allowed: true, reason: null, adjustedLotSize: null }),
            shouldHalt: () => ({ halt: false, reason: null }),
          },
          metrics: { update: () => {}, snapshot: () => ({}) },
          auditLog: {
            // eslint-disable-next-line @typescript-eslint/require-await
            async recordSignal() {},
            // eslint-disable-next-line @typescript-eslint/require-await
            async recordEvent() {},
          },
          sessionId: cfg.sessionId,
          mode: "backtest",
          subscriptions: [],
        };
      },
    });
    const sys = await buildSystem(baseBacktestConfig());
    expect(factoryCalled).toBe(true);
    expect(sys).toBeDefined();
  });
});
