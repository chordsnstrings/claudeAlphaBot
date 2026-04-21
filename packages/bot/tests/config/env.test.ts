import { describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";

function base(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://x",
    NODE_ENV: "test",
  } as NodeJS.ProcessEnv;
}

describe("loadEnv", () => {
  it("accepts backtest mode with minimal env", () => {
    const env = loadEnv({ ...base(), BOT_MODE: "backtest" });
    expect(env.BOT_MODE).toBe("backtest");
  });

  it("rejects missing DATABASE_URL with a clear message", () => {
    expect(() => loadEnv({ BOT_MODE: "backtest" } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  it("rejects paper mode without BINANCE_API_KEY", () => {
    expect(() => loadEnv({ ...base(), BOT_MODE: "paper", ARTIFACT_PATH: "/x" })).toThrow(
      /BINANCE_API_KEY/,
    );
  });

  it("rejects paper mode without ARTIFACT_PATH", () => {
    expect(() =>
      loadEnv({ ...base(), BOT_MODE: "paper", BINANCE_API_KEY: "k" }),
    ).toThrow(/ARTIFACT_PATH/);
  });

  it("rejects live mode without BINANCE_API_SECRET", () => {
    expect(() =>
      loadEnv({
        ...base(),
        BOT_MODE: "live",
        BINANCE_API_KEY: "k",
        ARTIFACT_PATH: "/x",
      }),
    ).toThrow(/BINANCE_API_SECRET/);
  });

  it("coerces BOT_HTTP_PORT from string", () => {
    const env = loadEnv({ ...base(), BOT_MODE: "backtest", BOT_HTTP_PORT: "9090" });
    expect(env.BOT_HTTP_PORT).toBe(9090);
  });
});
