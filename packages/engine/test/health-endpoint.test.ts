import type { Clock, ExecutionAdapter, MarketDataFeed } from "@trading/core";
import { describe, expect, it } from "vitest";

import { computeHealth } from "../src/health-endpoint.js";

function stubFeed(connected: boolean): MarketDataFeed {
  return {
    async start() {},
    async stop() {},
    isConnected: () => connected,
    getCurrentBar: () => null,
    async getHistoricalBars() {
      return [];
    },
    async *subscribe(): AsyncIterable<never> {
      /* none */
    },
  };
}

function stubExec(connected: boolean): ExecutionAdapter {
  return {
    async start() {},
    async stop() {},
    isConnected: () => connected,
    async submitOrder() {
      throw new Error("unused");
    },
    async cancelOrder() {},
    async modifyOrder() {
      throw new Error("unused");
    },
    async closePosition() {
      throw new Error("unused");
    },
    async getOpenPositions() {
      return [];
    },
    async getAccountInfo() {
      throw new Error("unused");
    },
    async *subscribeOrderUpdates(): AsyncIterable<never> {
      /* none */
    },
  };
}

const clock: Clock = {
  now: () => new Date("2025-06-15T12:00:00Z"),
  sleep: async () => {},
};

describe("computeHealth", () => {
  it("ok when DB pings + both adapters connected", async () => {
    const report = await computeHealth({
      dbPing: async () => null,
      dataFeed: stubFeed(true),
      execution: stubExec(true),
      clock,
      codeVersion: "abc123",
      startedAt: new Date("2025-06-15T11:00:00Z"),
    });
    expect(report.status).toBe("ok");
    expect(report.uptimeSeconds).toBe(3600);
    expect(report.codeVersion).toBe("abc123");
    expect(report.components.database.ok).toBe(true);
    expect(report.components.dataFeed.ok).toBe(true);
    expect(report.components.execution.ok).toBe(true);
  });

  it("degraded when DB unhealthy", async () => {
    const report = await computeHealth({
      dbPing: async () => "connection refused",
      dataFeed: stubFeed(true),
      execution: stubExec(true),
      clock,
      codeVersion: "x",
      startedAt: new Date("2025-06-15T11:00:00Z"),
    });
    expect(report.status).toBe("degraded");
    expect(report.components.database.error).toBe("connection refused");
  });

  it("degraded when an adapter is down", async () => {
    const report = await computeHealth({
      dataFeed: stubFeed(true),
      execution: stubExec(false),
      clock,
      codeVersion: "x",
      startedAt: new Date("2025-06-15T11:00:00Z"),
    });
    expect(report.status).toBe("degraded");
    expect(report.components.execution.ok).toBe(false);
  });
});
