/**
 * Regime drift monitor — spec §8.12.
 *
 * Two pure entry points:
 *
 *   classifySymbolOutcome(args) → { outcome: UNCHANGED | DRIFTED | FLIPPED, ... }
 *     Compares the CURRENT classifier output for one symbol against
 *     the validation snapshot baseline + recent daily history.
 *
 *   aggregatePortfolioOutcome(symbolOutcomes, history) → PortfolioOutcome
 *     Aggregates all three symbols + recent multi-day history.
 *
 * Thresholds (spec §8.12.7):
 *   DRIFT_CONFIDENCE_DROP_PCT             = 30
 *   DRIFT_BB_WIDTH_DELTA_POINTS           = 25
 *   FLIP_CONSECUTIVE_DAYS_REGIME_CHANGE   = 3
 *   FLIP_CONSECUTIVE_DAYS_RANGING_TO_TRENDING = 3
 *   FLIP_CONSECUTIVE_DAYS_SQUEEZE_ENTRY   = 2
 *   FLIP_SYMBOLS_REQUIRED_FOR_PORTFOLIO_FLIP = 2
 *
 * The monitor is *stateless* — the caller supplies the recent
 * `dailyHistory` of outcomes (per spec §8.12.6 `regime_check_log` table).
 * That keeps this module pure and trivially testable.
 *
 * IMPORTANT — actions per spec §8.12.2:
 *   PORTFOLIO_FLIPPED:
 *     - Log severity HIGH
 *     - Pause new entries on AFFECTED SYMBOLS ONLY (not all)
 *     - Do NOT close existing positions
 *     - Trigger full re-validation pipeline within 24h
 *   PORTFOLIO_DRIFTED:
 *     - Log + alert; continue trading; increase monitoring frequency
 *   PORTFOLIO_UNCHANGED:
 *     - Audit log only
 *
 * `affectedSymbolsForPause()` returns the list of symbols that should
 * be paused for new entries given the current per-symbol outcomes —
 * this is the data the scheduler reads to gate new entries.
 */
import type {
  DriftOutcome,
  PortfolioOutcome,
  Regime,
  Symbol as TradingSymbol,
  SymbolSnapshot,
} from "@hydra/shared";

export const DRIFT_CONFIDENCE_DROP_PCT = 30;
export const DRIFT_BB_WIDTH_DELTA_POINTS = 25;
export const FLIP_CONSECUTIVE_DAYS_REGIME_CHANGE = 3;
export const FLIP_CONSECUTIVE_DAYS_RANGING_TO_TRENDING = 3;
export const FLIP_CONSECUTIVE_DAYS_SQUEEZE_ENTRY = 2;
export const FLIP_SYMBOLS_REQUIRED_FOR_PORTFOLIO_FLIP = 2;

export interface DriftMonitorOptions {
  readonly confidenceDropPct?: number;
  readonly bbWidthDeltaPoints?: number;
  readonly flipConsecutiveDaysRegimeChange?: number;
  readonly flipConsecutiveDaysRangingToTrending?: number;
  readonly flipConsecutiveDaysSqueezeEntry?: number;
  readonly flipSymbolsRequiredForPortfolioFlip?: number;
}

/** A prior daily check entry for a single symbol, oldest → newest. */
export interface DailyCheckEntry {
  readonly timestampUtc: number;
  readonly symbol: TradingSymbol;
  readonly currentRegime: Regime;
  readonly outcome: DriftOutcome;
}

export interface SymbolOutcomeInputs {
  readonly symbol: TradingSymbol;
  readonly snapshot: SymbolSnapshot;
  readonly current: {
    readonly regime: Regime;
    readonly confidence: number;
    readonly bbWidthPercentile: number;
    readonly ema99Slope: number;
  };
  /**
   * Recent daily check history for this symbol, oldest → newest, NOT
   * including today's check. Used to count consecutive days of regime
   * change (FLIPPED criterion).
   */
  readonly dailyHistory: readonly DailyCheckEntry[];
  readonly opts?: DriftMonitorOptions;
}

export interface SymbolOutcomeResult {
  readonly symbol: TradingSymbol;
  readonly outcome: DriftOutcome;
  readonly currentRegime: Regime;
  readonly validationRegime: Regime;
  readonly confidenceCurrent: number;
  readonly confidenceAtValidation: number;
  readonly confidenceDeltaPct: number;
  readonly bbWidthCurrent: number;
  readonly bbWidthAtValidation: number;
  readonly bbWidthDeltaPoints: number;
  readonly ema99SlopeCurrent: number;
  readonly ema99SlopeAtValidation: number;
  readonly consecutiveDaysSameOutcome: number;
  readonly reason: string;
}

/**
 * Classify outcome for one symbol per spec §8.12.2. Pure function
 * over the snapshot baseline, current regime metrics, and recent
 * daily history.
 */
export function classifySymbolOutcome(inputs: SymbolOutcomeInputs): SymbolOutcomeResult {
  const opts = inputs.opts ?? {};
  const dropPct = opts.confidenceDropPct ?? DRIFT_CONFIDENCE_DROP_PCT;
  const bbDelta = opts.bbWidthDeltaPoints ?? DRIFT_BB_WIDTH_DELTA_POINTS;
  const flipDaysRegimeChange =
    opts.flipConsecutiveDaysRegimeChange ?? FLIP_CONSECUTIVE_DAYS_REGIME_CHANGE;
  const flipDaysRangingToTrending =
    opts.flipConsecutiveDaysRangingToTrending ?? FLIP_CONSECUTIVE_DAYS_RANGING_TO_TRENDING;
  const flipDaysSqueeze =
    opts.flipConsecutiveDaysSqueezeEntry ?? FLIP_CONSECUTIVE_DAYS_SQUEEZE_ENTRY;

  const cur = inputs.current;
  const snap = inputs.snapshot;

  // Confidence delta as % of the validation-time confidence.
  const confidenceDeltaPct =
    snap.confidence > 0 ? ((cur.confidence - snap.confidence) / snap.confidence) * 100 : 0;
  const bbWidthDeltaPoints = cur.bbWidthPercentile - snap.bbWidthPercentile;
  const slopeFlipped =
    Math.sign(cur.ema99Slope) !== Math.sign(snap.ema99Slope) &&
    snap.ema99Slope !== 0 &&
    cur.ema99Slope !== 0;

  const regimeMatches = cur.regime === snap.regime;

  // Build a virtual "today" entry to make consecutive-day counting symmetric.
  // We classify the regime-change run length first, then decide outcome.
  const consecRegimeDifferent = consecutiveDaysWith(
    inputs.dailyHistory,
    inputs.symbol,
    (entry) => entry.currentRegime !== snap.regime,
    !regimeMatches,
  );

  // RANGING → TRENDING run (in either direction)
  const consecRangingToTrending = consecutiveDaysWith(
    inputs.dailyHistory,
    inputs.symbol,
    (entry) =>
      snap.regime === "RANGING" &&
      (entry.currentRegime === "TRENDING_UP" || entry.currentRegime === "TRENDING_DOWN"),
    snap.regime === "RANGING" && (cur.regime === "TRENDING_UP" || cur.regime === "TRENDING_DOWN"),
  );

  // Non-squeeze → squeeze run
  const consecSqueezeEntry = consecutiveDaysWith(
    inputs.dailyHistory,
    inputs.symbol,
    (entry) => entry.currentRegime === "SQUEEZE",
    cur.regime === "SQUEEZE" && snap.regime !== "SQUEEZE",
  );

  let outcome: DriftOutcome;
  let reason: string;

  if (
    consecRegimeDifferent >= flipDaysRegimeChange ||
    consecRangingToTrending >= flipDaysRangingToTrending ||
    consecSqueezeEntry >= flipDaysSqueeze
  ) {
    outcome = "FLIPPED";
    reason =
      consecSqueezeEntry >= flipDaysSqueeze
        ? `entered SQUEEZE for ${consecSqueezeEntry} consecutive days`
        : consecRangingToTrending >= flipDaysRangingToTrending
          ? `RANGING → ${cur.regime} for ${consecRangingToTrending} consecutive days`
          : `${snap.regime} → ${cur.regime} for ${consecRegimeDifferent} consecutive days`;
  } else if (regimeMatches) {
    const drifted =
      Math.abs(confidenceDeltaPct) > dropPct ||
      Math.abs(bbWidthDeltaPoints) > bbDelta ||
      slopeFlipped;
    outcome = drifted ? "DRIFTED" : "UNCHANGED";
    reason = drifted
      ? `regime ${cur.regime} matches but: confΔ=${confidenceDeltaPct.toFixed(1)}% bbΔ=${bbWidthDeltaPoints.toFixed(1)}pts slopeFlip=${slopeFlipped}`
      : `regime ${cur.regime} matches snapshot, all metrics within thresholds`;
  } else {
    // Regime differs but not yet sustained → DRIFTED (heading toward FLIPPED).
    outcome = "DRIFTED";
    reason = `${snap.regime} → ${cur.regime}, ${consecRegimeDifferent}d (need ${flipDaysRegimeChange} for FLIPPED)`;
  }

  // Consecutive same-outcome day count (today + history matching today).
  const consecutiveDaysSameOutcome = countConsecutiveSameOutcome(
    inputs.dailyHistory,
    inputs.symbol,
    outcome,
  );

  return {
    symbol: inputs.symbol,
    outcome,
    currentRegime: cur.regime,
    validationRegime: snap.regime,
    confidenceCurrent: cur.confidence,
    confidenceAtValidation: snap.confidence,
    confidenceDeltaPct,
    bbWidthCurrent: cur.bbWidthPercentile,
    bbWidthAtValidation: snap.bbWidthPercentile,
    bbWidthDeltaPoints,
    ema99SlopeCurrent: cur.ema99Slope,
    ema99SlopeAtValidation: snap.ema99Slope,
    consecutiveDaysSameOutcome,
    reason,
  };
}

/**
 * Walk `history` newest → oldest, counting how many consecutive days
 * matched the predicate. If `currentMatches` is true, today (=1)
 * starts the run.
 */
function consecutiveDaysWith(
  history: readonly DailyCheckEntry[],
  symbol: TradingSymbol,
  predicate: (e: DailyCheckEntry) => boolean,
  currentMatches: boolean,
): number {
  if (!currentMatches) return 0;
  let n = 1; // today
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i]!;
    if (e.symbol !== symbol) continue;
    if (predicate(e)) n++;
    else break;
  }
  return n;
}

function countConsecutiveSameOutcome(
  history: readonly DailyCheckEntry[],
  symbol: TradingSymbol,
  todaysOutcome: DriftOutcome,
): number {
  let n = 1;
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i]!;
    if (e.symbol !== symbol) continue;
    if (e.outcome === todaysOutcome) n++;
    else break;
  }
  return n;
}

export interface PortfolioInputs {
  /** Today's per-symbol outcomes. */
  readonly symbolOutcomes: readonly SymbolOutcomeResult[];
  /** Recent multi-symbol history — used for the "1 symbol FLIPPED 2 days" rule. */
  readonly dailyHistory: readonly DailyCheckEntry[];
  readonly opts?: DriftMonitorOptions;
}

export interface PortfolioResult {
  readonly outcome: PortfolioOutcome;
  readonly flippedSymbols: readonly TradingSymbol[];
  readonly driftedSymbols: readonly TradingSymbol[];
  readonly affectedSymbolsForPause: readonly TradingSymbol[];
  readonly reason: string;
}

/**
 * Aggregate per-symbol outcomes to a portfolio-level outcome per spec
 * §8.12.2:
 *   PORTFOLIO_FLIPPED:
 *     - 2+ symbols FLIPPED today, OR
 *     - 1 symbol FLIPPED on 2+ consecutive daily checks (today + ≥1 prior)
 *   PORTFOLIO_DRIFTED: any symbol DRIFTED, no flips
 *   PORTFOLIO_UNCHANGED: all symbols UNCHANGED
 */
export function aggregatePortfolioOutcome(inputs: PortfolioInputs): PortfolioResult {
  const required =
    inputs.opts?.flipSymbolsRequiredForPortfolioFlip ??
    FLIP_SYMBOLS_REQUIRED_FOR_PORTFOLIO_FLIP;
  const flippedToday = inputs.symbolOutcomes.filter((s) => s.outcome === "FLIPPED");
  const driftedToday = inputs.symbolOutcomes.filter((s) => s.outcome === "DRIFTED");

  // For each symbol that flipped today, check whether it also flipped yesterday.
  const flippedConsecutive: TradingSymbol[] = [];
  for (const s of flippedToday) {
    if (flippedYesterday(inputs.dailyHistory, s.symbol)) flippedConsecutive.push(s.symbol);
  }

  let outcome: PortfolioOutcome;
  let reason: string;
  if (flippedToday.length >= required) {
    outcome = "PORTFOLIO_FLIPPED";
    reason = `${flippedToday.length} symbols FLIPPED today (≥${required} required)`;
  } else if (flippedConsecutive.length > 0) {
    outcome = "PORTFOLIO_FLIPPED";
    reason = `${flippedConsecutive.join(",")} FLIPPED on consecutive days`;
  } else if (flippedToday.length > 0 || driftedToday.length > 0) {
    outcome = "PORTFOLIO_DRIFTED";
    reason =
      flippedToday.length > 0
        ? `1 symbol FLIPPED (${flippedToday[0]!.symbol}) + ${driftedToday.length} drifted — not yet portfolio-flip`
        : `${driftedToday.length} symbols DRIFTED, none flipped`;
  } else {
    outcome = "PORTFOLIO_UNCHANGED";
    reason = "all symbols UNCHANGED";
  }

  // Affected symbols for new-entry pause: ALL today's FLIPPED symbols
  // (regardless of portfolio outcome — even a single flip pauses just
  // that symbol per spec §8.12.5).
  const affectedSymbolsForPause = flippedToday.map((s) => s.symbol);

  return {
    outcome,
    flippedSymbols: flippedToday.map((s) => s.symbol),
    driftedSymbols: driftedToday.map((s) => s.symbol),
    affectedSymbolsForPause,
    reason,
  };
}

function flippedYesterday(
  history: readonly DailyCheckEntry[],
  symbol: TradingSymbol,
): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i]!;
    if (e.symbol !== symbol) continue;
    return e.outcome === "FLIPPED";
  }
  return false;
}
