import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { pino } from "pino";

import { Scheduler, currentMinuteUtc, type SchedulerJob } from "../../src/scheduler/runner.js";

/** Minimal in-memory Pool that mimics enough pg contract for Scheduler. */
class FakePool {
  readonly calls: { sql: string; params: unknown[] }[] = [];
  readonly rows: Array<{
    id: number;
    job_name: string;
    scheduled_for_utc: number;
    status: string;
    started_at_utc?: number;
    completed_at_utc?: number;
    error_message?: string;
  }> = [];
  private nextId = 1;

  async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ sql, params });
    if (/INSERT INTO scheduler_runs/.test(sql)) {
      const [jobName, scheduledForUtc] = params as [string, number];
      const exists = this.rows.find(
        (r) => r.job_name === jobName && r.scheduled_for_utc === scheduledForUtc,
      );
      if (exists) {
        // ON CONFLICT DO NOTHING → empty rows
        return { rows: [] };
      }
      const id = this.nextId++;
      this.rows.push({
        id,
        job_name: jobName,
        scheduled_for_utc: scheduledForUtc,
        status: "PENDING",
      });
      return { rows: [{ id } as unknown as T] };
    }
    if (/UPDATE scheduler_runs[\s\S]*SET status = 'RUNNING'/.test(sql)) {
      const [id, startedAt] = params as [number, number];
      const row = this.rows.find((r) => r.id === id && r.status === "PENDING");
      if (!row) return { rows: [] };
      row.status = "RUNNING";
      row.started_at_utc = startedAt;
      return { rows: [{ id: row.id } as unknown as T] };
    }
    if (/UPDATE scheduler_runs[\s\S]*SET status = 'OK'/.test(sql)) {
      const [id, completedAt] = params as [number, number];
      const row = this.rows.find((r) => r.id === id);
      if (row) {
        row.status = "OK";
        row.completed_at_utc = completedAt;
      }
      return { rows: [] };
    }
    if (/UPDATE scheduler_runs[\s\S]*SET status = 'FAILED'/.test(sql)) {
      const [id, completedAt, errMsg] = params as [number, number, string];
      const row = this.rows.find((r) => r.id === id);
      if (row) {
        row.status = "FAILED";
        row.completed_at_utc = completedAt;
        row.error_message = errMsg;
      }
      return { rows: [] };
    }
    if (/SELECT id FROM scheduler_runs/.test(sql)) {
      const [jobName, scheduledForUtc] = params as [string, number];
      const row = this.rows.find(
        (r) =>
          r.job_name === jobName && r.scheduled_for_utc === scheduledForUtc && r.status === "PENDING",
      );
      return { rows: row ? [{ id: row.id } as unknown as T] : [] };
    }
    if (/SELECT id, job_name, scheduled_for_utc[\s\S]*FROM scheduler_runs/.test(sql)) {
      const [before] = params as [number];
      const pending = this.rows
        .filter((r) => r.status === "PENDING" && r.scheduled_for_utc <= before)
        .sort((a, b) => a.scheduled_for_utc - b.scheduled_for_utc)
        .map(
          (r) =>
            ({
              id: r.id,
              job_name: r.job_name,
              scheduled_for_utc: String(r.scheduled_for_utc),
            }) as unknown as T,
        );
      return { rows: pending };
    }
    return { rows: [] };
  }
}

const asPool = (p: FakePool) => p as unknown as Pool;

function silentLogger() {
  return pino({ level: "silent" });
}

describe("Scheduler", () => {
  it("currentMinuteUtc rounds down to minute boundary", () => {
    const m = 1_700_000_040_000; // Math.floor(1_700_000_040_000 / 60000) * 60000
    expect(currentMinuteUtc(m)).toBe(m);
    expect(currentMinuteUtc(m + 500)).toBe(m);
    expect(currentMinuteUtc(m + 59_999)).toBe(m);
    expect(currentMinuteUtc(m + 60_000)).toBe(m + 60_000);
  });

  it("runNow executes a job and writes OK row", async () => {
    const pool = new FakePool();
    const calls: number[] = [];
    const job: SchedulerJob = {
      name: "TEST",
      cron: "0 0 * * *",
      handler: async (ts) => {
        calls.push(ts);
      },
    };
    const s = new Scheduler({
      pool: asPool(pool),
      logger: silentLogger(),
      jobs: [job],
      now: () => 1_700_000_000_000,
    });
    await s.runNow("TEST");
    expect(calls.length).toBe(1);
    const finalRow = pool.rows.find((r) => r.job_name === "TEST");
    expect(finalRow?.status).toBe("OK");
  });

  it("runNow surfaces failures as FAILED rows (not thrown)", async () => {
    const pool = new FakePool();
    const job: SchedulerJob = {
      name: "BROKEN",
      cron: "0 0 * * *",
      handler: async () => {
        throw new Error("boom");
      },
    };
    const s = new Scheduler({
      pool: asPool(pool),
      logger: silentLogger(),
      jobs: [job],
      now: () => 1,
    });
    await s.runNow("BROKEN");
    const r = pool.rows.find((row) => row.job_name === "BROKEN");
    expect(r?.status).toBe("FAILED");
    expect(r?.error_message).toBe("boom");
  });

  it("tick is idempotent: two fires at same scheduled_for_utc run handler once", async () => {
    const pool = new FakePool();
    let runs = 0;
    const job: SchedulerJob = {
      name: "DAILY",
      cron: "0 0 * * *",
      handler: async () => {
        runs++;
      },
    };
    const s = new Scheduler({
      pool: asPool(pool),
      logger: silentLogger(),
      jobs: [job],
      now: () => 1_700_000_000_000,
    });
    // Same minute → two ticks collapse to one handler invocation.
    await s.runNow("DAILY");
    await s.runNow("DAILY");
    expect(runs).toBe(1);
  });

  it("catchUpPending: a PENDING row with past scheduled_for_utc runs on start()", async () => {
    const pool = new FakePool();
    // Pre-seed a missed run.
    pool.rows.push({
      id: 99,
      job_name: "DAILY",
      scheduled_for_utc: 1_699_999_000_000,
      status: "PENDING",
    });
    let runs = 0;
    const job: SchedulerJob = {
      name: "DAILY",
      // cron string is validated but we won't wait for a real tick.
      cron: "0 0 * * *",
      handler: async () => {
        runs++;
      },
    };
    const s = new Scheduler({
      pool: asPool(pool),
      logger: silentLogger(),
      jobs: [job],
      now: () => 1_700_000_000_000,
    });
    await s.start();
    try {
      expect(runs).toBe(1);
      const row = pool.rows.find((r) => r.id === 99);
      expect(row?.status).toBe("OK");
    } finally {
      await s.stop();
    }
  });

  it("start() rejects an invalid cron expression", async () => {
    const pool = new FakePool();
    const job: SchedulerJob = {
      name: "BAD",
      cron: "not a cron",
      handler: async () => {},
    };
    const s = new Scheduler({
      pool: asPool(pool),
      logger: silentLogger(),
      jobs: [job],
      now: () => 1,
    });
    await expect(s.start()).rejects.toThrow(/Invalid cron/);
  });
});
