/**
 * Built-in scheduled jobs — spec §8.12 (daily regime check) + §8.11.3
 * (fortnightly re-validation).
 *
 * Cron times (UTC):
 *   - DAILY_REGIME_CHECK: 00:30 UTC every day  →  `30 0 * * *`
 *   - FORTNIGHTLY_REVALIDATION: 02:00 UTC every 14 days (spec cadence)
 *     expressed as "0 2 (star)/14 (star) (star)" — fires on days 1, 15, 29
 *     of each month. Exact 14-day stepping across month boundaries requires
 *     a custom trigger; the spec §8.11.3 accepts this as "fortnightly".
 */
import type { Pool } from "pg";
import type { Logger } from "pino";

import type {
  DriftOutcome,
  Regime,
  Symbol as TradingSymbol,
  SymbolSnapshot,
} from "@hydra/shared";

import {
  aggregatePortfolioOutcome,
  classifySymbolOutcome,
  type DailyCheckEntry,
  type SymbolOutcomeResult,
} from "../core/drift-monitor.js";
import type { SchedulerJob } from "./runner.js";

export interface CurrentMetrics {
  readonly symbol: TradingSymbol;
  readonly regime: Regime;
  readonly confidence: number;
  readonly bbWidthPercentile: number;
  readonly ema99Slope: number;
}

export interface ValidationBaseline {
  readonly artifactHash: string;
  readonly perSymbol: readonly SymbolSnapshot[];
}

export interface JobContext {
  readonly pool: Pool;
  readonly logger: Logger;
  /** Invoked by force-revalidate + fortnightly + portfolio-flip detection. */
  readonly triggerRevalidation: (trigger: string) => Promise<void>;
  /** Produces a per-symbol current snapshot for the regime check. */
  readonly captureCurrentMetrics: () => Promise<readonly CurrentMetrics[]>;
  /** Returns the currently-active validation snapshot baseline. */
  readonly loadValidationBaseline: () => Promise<ValidationBaseline | null>;
}

export const JOB_DAILY_REGIME_CHECK = "DAILY_REGIME_CHECK";
export const JOB_FORTNIGHTLY_REVAL = "FORTNIGHTLY_REVALIDATION";

export function buildJobs(ctx: JobContext): SchedulerJob[] {
  return [
    {
      name: JOB_DAILY_REGIME_CHECK,
      cron: "30 0 * * *",
      handler: async (scheduledForUtc) => {
        await dailyRegimeCheck(ctx, scheduledForUtc);
      },
    },
    {
      name: JOB_FORTNIGHTLY_REVAL,
      cron: "0 2 */14 * *",
      handler: async (scheduledForUtc) => {
        await fortnightlyRevalidation(ctx, scheduledForUtc);
      },
    },
  ];
}

/**
 * Daily regime check per spec §8.12. For each symbol we compute
 * UNCHANGED / DRIFTED / FLIPPED via `classifySymbolOutcome`, then the
 * portfolio-level outcome via `aggregatePortfolioOutcome`. Results are
 * written to `regime_check_log` for the consecutive-day logic to read
 * on the next tick.
 */
export async function dailyRegimeCheck(
  ctx: JobContext,
  scheduledForUtc: number,
): Promise<void> {
  const baseline = await ctx.loadValidationBaseline();
  if (!baseline) {
    ctx.logger.warn("daily regime check: no active validation baseline; skipping");
    return;
  }
  const current = await ctx.captureCurrentMetrics();
  const history = await loadRegimeHistory(ctx.pool, scheduledForUtc);
  const outcomes: SymbolOutcomeResult[] = [];

  for (const snap of current) {
    const base = baseline.perSymbol.find((s) => s.symbol === snap.symbol);
    if (!base) continue;
    const outcome = classifySymbolOutcome({
      symbol: snap.symbol,
      snapshot: base,
      current: {
        regime: snap.regime,
        confidence: snap.confidence,
        bbWidthPercentile: snap.bbWidthPercentile,
        ema99Slope: snap.ema99Slope,
      },
      dailyHistory: history.filter((h) => h.symbol === snap.symbol),
    });
    outcomes.push(outcome);
    await ctx.pool.query(
      `INSERT INTO regime_check_log (
         timestamp_utc, symbol, outcome,
         current_regime, validation_regime,
         confidence_current, confidence_at_validation, confidence_delta_pct,
         bb_width_pct_current, bb_width_pct_at_validation, bb_width_delta_points,
         ema99_slope_current, ema99_slope_at_validation,
         consecutive_days_same_outcome
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        scheduledForUtc,
        snap.symbol,
        outcome.outcome,
        outcome.currentRegime,
        outcome.validationRegime,
        outcome.confidenceCurrent,
        outcome.confidenceAtValidation,
        outcome.confidenceDeltaPct,
        outcome.bbWidthCurrent,
        outcome.bbWidthAtValidation,
        outcome.bbWidthDeltaPoints,
        outcome.ema99SlopeCurrent,
        outcome.ema99SlopeAtValidation,
        outcome.consecutiveDaysSameOutcome,
      ],
    );
  }

  const portfolio = aggregatePortfolioOutcome({
    symbolOutcomes: outcomes,
    dailyHistory: history,
  });
  ctx.logger.info(
    {
      outcome: portfolio.outcome,
      flipped: portfolio.flippedSymbols,
      drifted: portfolio.driftedSymbols,
      reason: portfolio.reason,
    },
    "daily regime check complete",
  );

  if (portfolio.outcome === "PORTFOLIO_FLIPPED") {
    ctx.logger.warn({ reason: portfolio.reason }, "portfolio FLIPPED — revalidating");
    await ctx.triggerRevalidation("FLIPPED");
  }
}

export async function fortnightlyRevalidation(
  ctx: JobContext,
  scheduledForUtc: number,
): Promise<void> {
  ctx.logger.info({ scheduledForUtc }, "fortnightly revalidation starting");
  await ctx.pool.query(
    `INSERT INTO revalidation_events (trigger_reason, started_at_utc) VALUES ($1, $2)`,
    ["FORTNIGHTLY", scheduledForUtc],
  );
  await ctx.triggerRevalidation("FORTNIGHTLY");
}

async function loadRegimeHistory(
  pool: Pool,
  before: number,
): Promise<readonly DailyCheckEntry[]> {
  const res = await pool.query<{
    timestamp_utc: string;
    symbol: TradingSymbol;
    current_regime: Regime;
    outcome: DriftOutcome;
  }>(
    `SELECT timestamp_utc::text, symbol, current_regime, outcome
       FROM regime_check_log
      WHERE timestamp_utc < $1
      ORDER BY timestamp_utc ASC`,
    [before],
  );
  return res.rows.map((r) => ({
    timestampUtc: Number(r.timestamp_utc),
    symbol: r.symbol,
    currentRegime: r.current_regime,
    outcome: r.outcome,
  }));
}
