/**
 * Small statistical primitives used by the metrics module.
 *
 * Kept dependency-free so the metrics package stays lean.
 */

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const x of xs) {
    sum += x;
  }
  return sum / xs.length;
}

/** Sample stddev (n-1). */
export function stddev(xs: readonly number[]): number {
  if (xs.length < 2) {
    return 0;
  }
  const m = mean(xs);
  let sq = 0;
  for (const x of xs) {
    const d = x - m;
    sq += d * d;
  }
  return Math.sqrt(sq / (xs.length - 1));
}

/**
 * Downside deviation per the standard Sortino definition:
 *   sqrt(sum((r - target)² for r < target) / N)
 * where N is the TOTAL count of observations (not just the negatives).
 * Returns 0 if there are no observations below target.
 */
export function downsideStddev(xs: readonly number[], target = 0): number {
  if (xs.length === 0) {
    return 0;
  }
  let sq = 0;
  let anyBelow = false;
  for (const x of xs) {
    if (x < target) {
      const d = x - target;
      sq += d * d;
      anyBelow = true;
    }
  }
  if (!anyBelow) {
    return 0;
  }
  return Math.sqrt(sq / xs.length);
}

/**
 * Percentile via linear interpolation (Excel-style; matches Pandas
 * `quantile(p, interpolation='linear')`). p is in [0, 1].
 */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) {
    return 0;
  }
  if (xs.length === 1) {
    return xs[0] ?? 0;
  }
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) {
    return sorted[lo] ?? 0;
  }
  const frac = idx - lo;
  return (sorted[lo] ?? 0) * (1 - frac) + (sorted[hi] ?? 0) * frac;
}

/** Standard error of the mean. */
export function standardError(xs: readonly number[]): number {
  if (xs.length === 0) {
    return 0;
  }
  return stddev(xs) / Math.sqrt(xs.length);
}
