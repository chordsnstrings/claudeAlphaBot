import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { pino } from "pino";

import type { SymbolSnapshot } from "@hydra/shared";

import {
  buildJobs,
  dailyRegimeCheck,
  fortnightlyRevalidation,
  JOB_DAILY_REGIME_CHECK,
  JOB_FORTNIGHTLY_REVAL,
  type CurrentMetrics,
  type JobContext,
} from "../../src/scheduler/jobs.js";

function snapshot(overrides: Partial<SymbolSnapshot> = {}): SymbolSnapshot {
  return {
    symbol: "BTCUSDT",
    regime: "TRENDING_UP",
    confidence: 80,
    bbWidthPercentile: 50,
    ema99Slope: 0.2,
    atrPct: 1.5,
    ...overrides,
  };
}

function metrics(overrides: Partial<CurrentMetrics> = {}): CurrentMetrics {
  return {
    symbol: "BTCUSDT",
    regime: "TRENDING_UP",
    confidence: 82,
    bbWidthPercentile: 52,
    ema99Slope: 0.21,
    ...overrides,
  };
}

class FakePool {
  readonly calls: { sql: string; params: unknown[] }[] = [];
  regimeHistoryRows: unknown[] = [];

  async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ sql, params });
    if (/FROM regime_check_log/.test(sql)) {
      return { rows: this.regimeHistoryRows as unknown as T[] };
    }
    return { rows: [] };
  }
}

function ctxOf(
  pool: FakePool,
  overrides: Partial<JobContext> = {},
): JobContext {
  const triggers: string[] = [];
  const base: JobContext = {
    pool: pool as unknown as Pool,
    logger: pino({ level: "silent" }),
    triggerRevalidation: async (reason) => {
      triggers.push(reason);
    },
    captureCurrentMetrics: async () => [metrics()],
    loadValidationBaseline: async () => ({
      artifactHash: "sha256:abc",
      perSymbol: [snapshot()],
    }),
  };
  // Wrap triggerRevalidation so caller can inspect triggers[].
  const ctx = { ...base, ...overrides };
  (ctx as unknown as { __triggers: string[] }).__triggers = triggers;
  return ctx;
}

describe("buildJobs", () => {
  it("registers daily regime + fortnightly jobs with UTC cron expressions", () => {
    const pool = new FakePool();
    const jobs = buildJobs(ctxOf(pool));
    const daily = jobs.find((j) => j.name === JOB_DAILY_REGIME_CHECK);
    const fortnightly = jobs.find((j) => j.name === JOB_FORTNIGHTLY_REVAL);
    expect(daily?.cron).toBe("30 0 * * *");
    expect(fortnightly?.cron).toBe("0 2 */14 * *");
  });
});

describe("dailyRegimeCheck", () => {
  it("skips gracefully when no validation baseline is active", async () => {
    const pool = new FakePool();
    const ctx = ctxOf(pool, { loadValidationBaseline: async () => null });
    await dailyRegimeCheck(ctx, 1_700_000_000_000);
    // No inserts into regime_check_log.
    expect(pool.calls.some((c) => /INSERT INTO regime_check_log/.test(c.sql))).toBe(false);
  });

  it("writes regime_check_log row for each matching current metric", async () => {
    const pool = new FakePool();
    const ctx = ctxOf(pool);
    await dailyRegimeCheck(ctx, 1_700_000_000_000);
    const inserts = pool.calls.filter((c) => /INSERT INTO regime_check_log/.test(c.sql));
    expect(inserts.length).toBe(1);
    // First param is the scheduled_for_utc timestamp.
    expect(inserts[0]!.params[0]).toBe(1_700_000_000_000);
    // Symbol and outcome are positional params $2, $3.
    expect(inserts[0]!.params[1]).toBe("BTCUSDT");
    expect(typeof inserts[0]!.params[2]).toBe("string");
  });

  it("triggers revalidation when portfolio outcome is FLIPPED", async () => {
    const pool = new FakePool();
    // Seed two symbols flipping for 3 consecutive days.
    const days = [1, 2, 3].map((d) => d * 86_400_000);
    pool.regimeHistoryRows = days.flatMap((ts) => [
      { timestamp_utc: String(ts), symbol: "BTCUSDT", current_regime: "RANGING", outcome: "FLIPPED" },
      { timestamp_utc: String(ts), symbol: "ETHUSDT", current_regime: "RANGING", outcome: "FLIPPED" },
    ]);
    const triggers: string[] = [];
    const ctx: JobContext = {
      pool: pool as unknown as Pool,
      logger: pino({ level: "silent" }),
      triggerRevalidation: async (r) => {
        triggers.push(r);
      },
      captureCurrentMetrics: async () => [
        metrics({ symbol: "BTCUSDT", regime: "RANGING" }),
        metrics({ symbol: "ETHUSDT", regime: "RANGING" }),
      ],
      loadValidationBaseline: async () => ({
        artifactHash: "sha256:abc",
        perSymbol: [
          snapshot({ symbol: "BTCUSDT", regime: "TRENDING_UP" }),
          snapshot({ symbol: "ETHUSDT", regime: "TRENDING_UP" }),
        ],
      }),
    };
    await dailyRegimeCheck(ctx, 4 * 86_400_000);
    expect(triggers).toContain("FLIPPED");
  });
});

describe("fortnightlyRevalidation", () => {
  it("inserts revalidation_events row and triggers FORTNIGHTLY", async () => {
    const pool = new FakePool();
    const triggers: string[] = [];
    const ctx: JobContext = {
      pool: pool as unknown as Pool,
      logger: pino({ level: "silent" }),
      triggerRevalidation: async (r) => {
        triggers.push(r);
      },
      captureCurrentMetrics: async () => [],
      loadValidationBaseline: async () => null,
    };
    await fortnightlyRevalidation(ctx, 1_700_000_000_000);
    expect(pool.calls.some((c) => /INSERT INTO revalidation_events/.test(c.sql))).toBe(true);
    expect(triggers).toEqual(["FORTNIGHTLY"]);
  });
});
