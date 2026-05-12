/**
 * Equity-curve derivations from a trade list.
 *
 * Given a starting equity and a chronologically sorted list of closed
 * trades, we can reconstruct:
 *   - the per-trade equity points
 *   - the daily/weekly/monthly equity samples
 *   - period returns
 *   - max drawdown (USD + %) and its duration in days
 */

export interface ClosedTrade {
  entryTime: Date;
  exitTime: Date;
  realizedPnLUsd: number;
  realizedRMultiple: number;
  originatingStrategy: string;
}

export interface EquityPoint {
  at: Date;
  equityUsd: number;
}

export interface DrawdownResult {
  maxDdUsd: number;
  /** Negative number (e.g. -0.15 for -15%). */
  maxDdPct: number;
  durationDays: number;
  peakAt: Date | null;
  troughAt: Date | null;
}

export function equityCurve(
  initialEquityUsd: number,
  trades: readonly ClosedTrade[],
): EquityPoint[] {
  const sorted = [...trades].sort(
    (a, b) => a.exitTime.getTime() - b.exitTime.getTime(),
  );
  let equity = initialEquityUsd;
  const out: EquityPoint[] = [
    { at: sorted[0]?.entryTime ?? new Date(0), equityUsd: equity },
  ];
  for (const t of sorted) {
    equity += t.realizedPnLUsd;
    out.push({ at: t.exitTime, equityUsd: equity });
  }
  return out;
}

/** Max drawdown computed from an equity curve. */
export function maxDrawdown(points: readonly EquityPoint[]): DrawdownResult {
  if (points.length === 0) {
    return { maxDdUsd: 0, maxDdPct: 0, durationDays: 0, peakAt: null, troughAt: null };
  }
  let peak = points[0]?.equityUsd ?? 0;
  let peakAt = points[0]?.at ?? null;
  let maxDdUsd = 0;
  let maxDdPct = 0;
  let troughAt: Date | null = null;
  let bestPeakAt: Date | null = null;
  for (const p of points) {
    if (p.equityUsd > peak) {
      peak = p.equityUsd;
      peakAt = p.at;
    }
    const dd = p.equityUsd - peak;
    if (dd < maxDdUsd) {
      maxDdUsd = dd;
      maxDdPct = peak === 0 ? 0 : dd / peak;
      troughAt = p.at;
      bestPeakAt = peakAt;
    }
  }
  const durationDays =
    bestPeakAt !== null && troughAt !== null
      ? Math.max(
          0,
          Math.floor(
            (troughAt.getTime() - bestPeakAt.getTime()) / 86_400_000,
          ),
        )
      : 0;
  return {
    maxDdUsd,
    maxDdPct,
    durationDays,
    peakAt: bestPeakAt,
    troughAt,
  };
}

/**
 * Daily return series from an equity curve. Returns the percentage change
 * from one UTC-day equity sample to the next; if multiple equity points
 * fall on the same day, the latest sample wins.
 */
export function dailyReturns(points: readonly EquityPoint[]): number[] {
  if (points.length < 2) {
    return [];
  }
  // Bucket by UTC-date, keep the last equity for that day.
  const byDay = new Map<string, number>();
  for (const p of points) {
    byDay.set(p.at.toISOString().slice(0, 10), p.equityUsd);
  }
  const days = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const out: number[] = [];
  for (let i = 1; i < days.length; i += 1) {
    const prevEntry = days[i - 1];
    const curEntry = days[i];
    if (prevEntry === undefined || curEntry === undefined) {
      continue;
    }
    const prev = prevEntry[1];
    const cur = curEntry[1];
    if (prev === 0) {
      continue;
    }
    out.push((cur - prev) / prev);
  }
  return out;
}

/** Total return % computed from the first and last equity points. */
export function totalReturnPct(points: readonly EquityPoint[]): number {
  if (points.length < 2) {
    return 0;
  }
  const first = points[0]?.equityUsd ?? 0;
  const last = points[points.length - 1]?.equityUsd ?? 0;
  if (first === 0) {
    return 0;
  }
  return (last - first) / first;
}

/** Compound annual growth rate over the span of the equity curve. */
export function cagr(points: readonly EquityPoint[]): number {
  if (points.length < 2) {
    return 0;
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined || first.equityUsd <= 0) {
    return 0;
  }
  const years = (last.at.getTime() - first.at.getTime()) / (365.25 * 86_400_000);
  if (years <= 0) {
    return 0;
  }
  const ratio = last.equityUsd / first.equityUsd;
  return Math.pow(ratio, 1 / years) - 1;
}
