import { describe, expect, it } from "vitest";

import { ConfigValidationError, loadEnvConfig } from "../src/config.js";

const baseBacktestEnv = {
  NODE_ENV: "development",
  LOG_LEVEL: "info",
  MODE: "backtest",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  BACKTEST_START_DATE: "2020-01-01",
  BACKTEST_END_DATE: "2026-05-12",
  BACKTEST_INITIAL_EQUITY_USD: "100000",
  BACKTEST_FRICTION_PROFILE: "pepperstone_razor",
  BACKTEST_RANDOM_SEED: "42",
} satisfies Record<string, string>;

const baseLiveEnv = {
  NODE_ENV: "production",
  LOG_LEVEL: "info",
  MODE: "live",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  CTRADER_CLIENT_ID: "abc",
  CTRADER_CLIENT_SECRET: "secret",
  CTRADER_ACCOUNT_ID: "5286746",
  CTRADER_ACCOUNT_TYPE: "demo",
  CTRADER_REDIRECT_URL: "https://bot.example.com/oauth/callback",
} satisfies Record<string, string>;

describe("loadEnvConfig", () => {
  it("accepts a valid backtest config", () => {
    const cfg = loadEnvConfig(baseBacktestEnv);
    expect(cfg.MODE).toBe("backtest");
    if (cfg.MODE === "backtest") {
      expect(cfg.backtest.BACKTEST_INITIAL_EQUITY_USD).toBe(100000);
      expect(cfg.backtest.BACKTEST_RANDOM_SEED).toBe(42n);
      expect(cfg.live).toBeNull();
    }
  });

  it("accepts a valid live config", () => {
    const cfg = loadEnvConfig(baseLiveEnv);
    expect(cfg.MODE).toBe("live");
    if (cfg.MODE === "live") {
      expect(cfg.live.CTRADER_CLIENT_ID).toBe("abc");
      expect(cfg.backtest).toBeNull();
    }
  });

  it("rejects missing backtest fields when MODE=backtest", () => {
    const env = { ...baseBacktestEnv } as Record<string, string>;
    delete env["BACKTEST_START_DATE"];
    expect(() => loadEnvConfig(env)).toThrow(ConfigValidationError);
    try {
      loadEnvConfig(env);
    } catch (err) {
      expect(String(err)).toContain("BACKTEST_START_DATE");
    }
  });

  it("rejects missing live fields when MODE=live", () => {
    const env = { ...baseLiveEnv } as Record<string, string>;
    delete env["CTRADER_CLIENT_ID"];
    expect(() => loadEnvConfig(env)).toThrow(ConfigValidationError);
  });

  it("rejects invalid DATABASE_URL scheme", () => {
    const env = { ...baseBacktestEnv, DATABASE_URL: "mysql://x" };
    expect(() => loadEnvConfig(env)).toThrow(/postgres:\/\//u);
  });

  it("rejects inverted backtest date range", () => {
    const env = {
      ...baseBacktestEnv,
      BACKTEST_START_DATE: "2026-01-01",
      BACKTEST_END_DATE: "2020-01-01",
    };
    expect(() => loadEnvConfig(env)).toThrow(/must be <=/u);
  });

  it("rejects unknown MODE", () => {
    const env = { ...baseBacktestEnv, MODE: "wishful" };
    expect(() => loadEnvConfig(env)).toThrow(ConfigValidationError);
  });
});
