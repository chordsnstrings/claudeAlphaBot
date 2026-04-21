/**
 * Scheduler — node-cron with DB-backed missed-run recovery.
 *
 * Each job has:
 *   - a name (stored in `scheduler_runs.job_name`)
 *   - a cron spec (UTC)
 *   - a handler
 *
 * On `start()`:
 *   1. Run catch-up: find any PENDING rows with scheduled_for_utc < now
 *      and no completed_at_utc, and execute them. This is what lets a
 *      bot that was offline at 00:30 UTC still run its daily check when
 *      it restarts at 00:35.
 *   2. Register the cron tick. Each fire computes the nominal UTC
 *      minute-boundary timestamp, upserts a `scheduler_runs` PENDING
 *      row (ON CONFLICT DO NOTHING so idempotent), then claims + runs it.
 *
 * The run state machine: PENDING → RUNNING → OK | FAILED | SKIPPED.
 *
 * Claim semantics: a single UPDATE ... RETURNING id flips PENDING→RUNNING
 * with a WHERE clause guarding `status='PENDING'`, so two processes
 * cannot run the same (job_name, scheduled_for_utc) twice. This is the
 * "at-most-once-started" guarantee; for "at-least-once completed" the
 * catch-up sweep on the next start picks up anything that crashed.
 */
import cron, { type ScheduledTask } from "node-cron";
import type { Pool } from "pg";
import type { Logger } from "pino";

export interface SchedulerJob {
  readonly name: string;
  /** Standard 5- or 6-field cron expression in UTC. */
  readonly cron: string;
  readonly handler: (scheduledForUtc: number) => Promise<void>;
}

export interface SchedulerOptions {
  readonly pool: Pool;
  readonly logger: Logger;
  readonly jobs: readonly SchedulerJob[];
  /** Override `Date.now` for tests. */
  readonly now?: () => number;
}

export class Scheduler {
  private readonly pool: Pool;
  private readonly logger: Logger;
  private readonly jobs: readonly SchedulerJob[];
  private readonly now: () => number;
  private tasks: ScheduledTask[] = [];
  private started = false;

  constructor(opts: SchedulerOptions) {
    this.pool = opts.pool;
    this.logger = opts.logger;
    this.jobs = opts.jobs;
    this.now = opts.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // 1. Catch up on any missed runs.
    await this.catchUpPending();

    // 2. Register cron tasks.
    for (const job of this.jobs) {
      if (!cron.validate(job.cron)) {
        throw new Error(`Invalid cron expression for job ${job.name}: ${job.cron}`);
      }
      const task = cron.schedule(
        job.cron,
        () => {
          const scheduledForUtc = currentMinuteUtc(this.now());
          void this.tick(job, scheduledForUtc);
        },
        { timezone: "UTC" },
      );
      this.tasks.push(task);
      this.logger.info({ job: job.name, cron: job.cron }, "scheduler: job registered");
    }
  }

  async stop(): Promise<void> {
    for (const t of this.tasks) t.stop();
    this.tasks = [];
    this.started = false;
  }

  /** Fire a job immediately. Used by the `force-revalidate` API command. */
  async runNow(jobName: string): Promise<void> {
    const job = this.jobs.find((j) => j.name === jobName);
    if (!job) throw new Error(`unknown job: ${jobName}`);
    await this.tick(job, this.now());
  }

  /**
   * Single tick: reserve (job_name, scheduled_for_utc) row, then run.
   * If the row already exists in RUNNING/OK/FAILED we skip.
   */
  private async tick(job: SchedulerJob, scheduledForUtc: number): Promise<void> {
    const insertRes = await this.pool.query<{ id: number }>(
      `INSERT INTO scheduler_runs (job_name, scheduled_for_utc, status)
       VALUES ($1, $2, 'PENDING')
       ON CONFLICT (job_name, scheduled_for_utc) DO NOTHING
       RETURNING id`,
      [job.name, scheduledForUtc],
    );
    const id =
      insertRes.rows[0]?.id ??
      (
        await this.pool.query<{ id: number }>(
          `SELECT id FROM scheduler_runs
            WHERE job_name = $1 AND scheduled_for_utc = $2
              AND status = 'PENDING'`,
          [job.name, scheduledForUtc],
        )
      ).rows[0]?.id;
    if (!id) {
      // Row exists but not pending → already handled.
      return;
    }
    await this.runClaim(job, id, scheduledForUtc);
  }

  private async runClaim(
    job: SchedulerJob,
    id: number,
    scheduledForUtc: number,
  ): Promise<void> {
    // Atomic claim: PENDING → RUNNING.
    const claim = await this.pool.query<{ id: number }>(
      `UPDATE scheduler_runs
          SET status = 'RUNNING', started_at_utc = $2
        WHERE id = $1 AND status = 'PENDING'
        RETURNING id`,
      [id, this.now()],
    );
    if (claim.rows.length === 0) {
      // Someone else beat us — fine.
      return;
    }
    const startedAt = this.now();
    try {
      await job.handler(scheduledForUtc);
      await this.pool.query(
        `UPDATE scheduler_runs
            SET status = 'OK', completed_at_utc = $2
          WHERE id = $1`,
        [id, this.now()],
      );
      this.logger.info(
        { job: job.name, scheduledForUtc, durationMs: this.now() - startedAt },
        "scheduler: job OK",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.pool.query(
        `UPDATE scheduler_runs
            SET status = 'FAILED', completed_at_utc = $2, error_message = $3
          WHERE id = $1`,
        [id, this.now(), msg.slice(0, 1000)],
      );
      this.logger.error({ job: job.name, scheduledForUtc, err: msg }, "scheduler: job FAILED");
    }
  }

  /**
   * On startup, look for PENDING rows whose scheduled_for_utc is in the
   * past + handle them. The DB is the source of truth for "I should
   * have run but didn't."
   */
  private async catchUpPending(): Promise<void> {
    const nowMs = this.now();
    const pending = await this.pool.query<{ id: number; job_name: string; scheduled_for_utc: string }>(
      `SELECT id, job_name, scheduled_for_utc
         FROM scheduler_runs
        WHERE status = 'PENDING' AND scheduled_for_utc <= $1
        ORDER BY scheduled_for_utc ASC`,
      [nowMs],
    );
    for (const row of pending.rows) {
      const job = this.jobs.find((j) => j.name === row.job_name);
      if (!job) continue;
      this.logger.warn(
        { job: row.job_name, scheduledForUtc: Number(row.scheduled_for_utc) },
        "scheduler: catching up on missed run",
      );
      await this.runClaim(job, row.id, Number(row.scheduled_for_utc));
    }
  }
}

/**
 * Round `nowMs` down to the current UTC minute. The cron fires on minute
 * boundaries so the scheduler keys runs by minute — two fires at
 * different ms within the same minute collapse to one row.
 */
export function currentMinuteUtc(nowMs: number): number {
  return Math.floor(nowMs / 60_000) * 60_000;
}
