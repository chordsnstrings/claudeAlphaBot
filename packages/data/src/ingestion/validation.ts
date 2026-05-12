/**
 * Validation pipeline. Runs on already-loaded bars in the DB and writes
 * issues to `data_validation_issue`. Spec section 9.3:
 *   - Gap detection (missing trading days for daily; missing minutes for M1)
 *   - OHLC sanity (high >= max(o,c,l); low <= min(o,c,h))
 *   - Magnitude check (median price inside expectedRange)
 *   - Zero-volume flagging
 *
 * The OHLC check is also enforced by a CHECK constraint in 0002, so any
 * row passing INSERT is already structurally consistent. We still surface
 * a query-side check to verify nothing slipped in via raw INSERT path.
 */

import type { Repos } from "../repos/index.js";
import { expectedRange } from "./price-ranges.js";

export type Severity = "info" | "warn" | "error";
export type ValidatedTimeframe = "m1" | "m5" | "h1" | "d1";

export interface ValidationSummary {
  instrument: string;
  timeframe: ValidatedTimeframe;
  totalBars: number;
  gaps: number;
  ohlcViolations: number;
  magnitudeIssues: number;
  zeroVolume: number;
  issueIds: string[];
}

const ONE_MIN_MS = 60_000;
const ONE_DAY_MS = 86_400_000;
const FOUR_HOURS_MS = 4 * 3_600_000;

/** Allowable inter-bar gap before flagging, by timeframe. */
function maxAllowedGapMs(timeframe: ValidatedTimeframe): number {
  switch (timeframe) {
    case "m1":
      return ONE_MIN_MS + 1;
    case "m5":
      return 5 * ONE_MIN_MS + 1;
    case "h1":
      return 3_600_000 + 1;
    case "d1":
      return ONE_DAY_MS + 1;
    default: {
      const exhaustive: never = timeframe;
      throw new Error(`unhandled timeframe: ${String(exhaustive)}`);
    }
  }
}

/**
 * True if the gap (prev -> next) is the expected weekend break:
 * the last bar is at or after Friday 22:00 UTC, the next bar is at or
 * after the following Sunday 22:00 UTC, and the elapsed time is <= 49h.
 */
function isWeekendGap(prev: Date, next: Date): boolean {
  const prevDow = prev.getUTCDay(); // 0=Sun..6=Sat
  const nextDow = next.getUTCDay();
  const prevHour = prev.getUTCHours();
  const nextHour = next.getUTCHours();
  const delta = next.getTime() - prev.getTime();

  // prev must sit at/after Friday close (Fri 22:00+) or on Saturday before
  // Sunday 22:00 — i.e. it's the last bar before the weekend.
  const prevAtOrAfterFriClose =
    (prevDow === 5 && prevHour >= 22) || prevDow === 6 || (prevDow === 0 && prevHour < 22);
  // next must sit at/after Sunday 22:00 — first bar after the weekend.
  const nextAtOrAfterSundayOpen =
    (nextDow === 0 && nextHour >= 22) || nextDow === 1 || nextDow === 2;

  return prevAtOrAfterFriClose && nextAtOrAfterSundayOpen && delta <= 49 * 3_600_000;
}

export async function validateInstrumentTimeframe(
  repos: Repos,
  instrument: string,
  timeframe: ValidatedTimeframe,
  from: Date,
  to: Date,
): Promise<ValidationSummary> {
  const bars = await repos.bars.findRange(instrument, timeframe, from, to);
  const summary: ValidationSummary = {
    instrument,
    timeframe,
    totalBars: bars.length,
    gaps: 0,
    ohlcViolations: 0,
    magnitudeIssues: 0,
    zeroVolume: 0,
    issueIds: [],
  };
  if (bars.length === 0) {
    return summary;
  }

  // --- Gap detection ------------------------------------------------------
  const maxGap = maxAllowedGapMs(timeframe);
  const weekendTolerance = FOUR_HOURS_MS;
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1];
    const cur = bars[i];
    if (prev === undefined || cur === undefined) {
      continue;
    }
    const delta = cur.timestampUtc.getTime() - prev.timestampUtc.getTime();
    if (delta <= maxGap) {
      continue;
    }
    // Don't flag the regular weekend break as a gap.
    if (
      (timeframe === "m1" || timeframe === "m5" || timeframe === "h1") &&
      isWeekendGap(prev.timestampUtc, cur.timestampUtc) &&
      delta < 49 * 3_600_000 + weekendTolerance
    ) {
      continue;
    }
    summary.gaps += 1;
    const issue = await repos.validation.insert({
      instrument,
      timeframe,
      issueType: "gap",
      severity: "warn",
      description: `gap of ${Math.round(delta / ONE_MIN_MS)} minutes`,
      affectedTimeRangeStart: prev.timestampUtc,
      affectedTimeRangeEnd: cur.timestampUtc,
    });
    summary.issueIds.push(issue.id);
  }

  // --- OHLC sanity (defence-in-depth; CHECK constraint also enforces) ----
  for (const b of bars) {
    const o = Number(b.open);
    const h = Number(b.high);
    const l = Number(b.low);
    const c = Number(b.close);
    if (h < Math.max(o, c, l) || l > Math.min(o, c, h)) {
      summary.ohlcViolations += 1;
      const issue = await repos.validation.insert({
        instrument,
        timeframe,
        issueType: "ohlc_violation",
        severity: "error",
        description: `OHLC inconsistent: o=${o} h=${h} l=${l} c=${c}`,
        affectedTimeRangeStart: b.timestampUtc,
        affectedTimeRangeEnd: b.timestampUtc,
      });
      summary.issueIds.push(issue.id);
    }
  }

  // --- Magnitude check ---------------------------------------------------
  const range = expectedRange(instrument);
  if (range !== null) {
    const closes = bars.map((b) => Number(b.close)).sort((a, b) => a - b);
    const midIdx = Math.floor(closes.length / 2);
    const median = closes[midIdx];
    if (median !== undefined) {
      const [lo, hi] = range;
      if (median < lo / 5 || median > hi * 5) {
        summary.magnitudeIssues += 1;
        const issue = await repos.validation.insert({
          instrument,
          timeframe,
          issueType: "magnitude",
          severity: "error",
          description:
            `median close ${median} far outside expected range [${lo}, ${hi}]; ` +
            "investigate ingestion scaling",
          affectedTimeRangeStart: from,
          affectedTimeRangeEnd: to,
        });
        summary.issueIds.push(issue.id);
      }
    }
  }

  // --- Zero-volume flagging ---------------------------------------------
  let zeroRun = 0;
  let zeroRunStart: Date | null = null;
  for (const b of bars) {
    if (Number(b.volume) === 0) {
      summary.zeroVolume += 1;
      if (zeroRun === 0) {
        zeroRunStart = b.timestampUtc;
      }
      zeroRun += 1;
    } else if (zeroRun > 0) {
      const prevBar = bars[bars.indexOf(b) - 1];
      if (zeroRun >= 5 && zeroRunStart !== null && prevBar !== undefined) {
        const issue = await repos.validation.insert({
          instrument,
          timeframe,
          issueType: "zero_volume_run",
          severity: "info",
          description: `${zeroRun} consecutive zero-volume bars`,
          affectedTimeRangeStart: zeroRunStart,
          affectedTimeRangeEnd: prevBar.timestampUtc,
        });
        summary.issueIds.push(issue.id);
      }
      zeroRun = 0;
      zeroRunStart = null;
    }
  }

  return summary;
}
