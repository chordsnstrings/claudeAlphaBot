/**
 * WalkForwardRunner — spec §8.2 + §9.12.
 *
 * Rolling train/test framework. Given a (from, to, train_months, test_months,
 * step_months), `planWindows()` produces the list of (is_from, is_to,
 * oos_from, oos_to) windows. The runner is the thin layer that converts
 * a window list into child sessions; the actual backtest invocation per
 * window is provided by the caller (it knows how to construct strategies +
 * adapters for a given window).
 *
 * No data leakage: each window's OOS run is built independently of the IS
 * run; the IS data set ends strictly before the OOS data set begins.
 *
 * Parent session aggregation: `summariseWalkForward(results)` computes
 * mean(OOS Sharpe) / mean(IS Sharpe) = "WF consistency".
 */

export interface WalkForwardConfig {
  /** Inclusive overall start. */
  from: Date;
  /** Inclusive overall end. */
  to: Date;
  trainMonths: number;
  testMonths: number;
  stepMonths: number;
  /** Drop windows whose IS or OOS produced fewer than this many trades. */
  minTradesPerWindow: number;
}

export interface WalkForwardWindow {
  index: number;
  isFrom: Date;
  isTo: Date;
  oosFrom: Date;
  oosTo: Date;
}

export interface WindowResult {
  window: WalkForwardWindow;
  isSharpe: number;
  oosSharpe: number;
  isTrades: number;
  oosTrades: number;
  isSessionId: string;
  oosSessionId: string;
}

export interface WalkForwardSummary {
  parentSessionId: string;
  windowCount: number;
  filteredWindowCount: number;
  meanIsSharpe: number;
  meanOosSharpe: number;
  /** OOS / IS Sharpe ratio per spec §8.2. */
  walkForwardConsistency: number;
  windows: WindowResult[];
}

function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

/**
 * Compute the rolling-window plan. The IS-end / OOS-start join is exact
 * (no gap, no overlap); IS uses [isFrom, isTo) and OOS uses
 * [oosFrom, oosTo). Windows that would extend past `to` are clipped.
 */
export function planWalkForwardWindows(cfg: WalkForwardConfig): WalkForwardWindow[] {
  if (cfg.from >= cfg.to) {
    return [];
  }
  if (cfg.trainMonths < 1 || cfg.testMonths < 1 || cfg.stepMonths < 1) {
    throw new Error("walk-forward: all month counts must be >= 1");
  }
  const out: WalkForwardWindow[] = [];
  let cursor = cfg.from;
  let idx = 0;
  let cont = true;
  while (cont) {
    const isFrom = cursor;
    const isTo = addMonths(isFrom, cfg.trainMonths);
    const oosFrom = isTo;
    const oosTo = addMonths(oosFrom, cfg.testMonths);
    if (oosTo > cfg.to) {
      // Clip the last window if there's still meaningful OOS room; else stop.
      if (oosFrom < cfg.to) {
        out.push({ index: idx, isFrom, isTo, oosFrom, oosTo: cfg.to });
      }
      cont = false;
      break;
    }
    out.push({ index: idx, isFrom, isTo, oosFrom, oosTo });
    idx += 1;
    cursor = addMonths(cursor, cfg.stepMonths);
  }
  return out;
}

/**
 * Aggregate per-window results into the parent summary. Windows whose IS
 * or OOS trade count is below `minTradesPerWindow` are excluded from the
 * mean. WF consistency = mean(OOS Sharpe) / mean(IS Sharpe); when IS mean
 * is zero (or windows is empty), reports 0.
 */
export function summariseWalkForward(
  parentSessionId: string,
  cfg: Pick<WalkForwardConfig, "minTradesPerWindow">,
  results: readonly WindowResult[],
): WalkForwardSummary {
  const filtered = results.filter(
    (r) => r.isTrades >= cfg.minTradesPerWindow && r.oosTrades >= cfg.minTradesPerWindow,
  );
  const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
  const meanIs = filtered.length === 0 ? 0 : sum(filtered.map((r) => r.isSharpe)) / filtered.length;
  const meanOos = filtered.length === 0 ? 0 : sum(filtered.map((r) => r.oosSharpe)) / filtered.length;
  return {
    parentSessionId,
    windowCount: results.length,
    filteredWindowCount: filtered.length,
    meanIsSharpe: meanIs,
    meanOosSharpe: meanOos,
    walkForwardConsistency: meanIs === 0 ? 0 : meanOos / meanIs,
    windows: [...results],
  };
}
