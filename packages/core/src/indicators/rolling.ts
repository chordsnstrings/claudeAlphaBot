/**
 * Rolling lookback helpers: high, low, percentile rank, and past-return.
 *
 * IMPORTANT: rollingHigh / rollingLow EXCLUDE the current bar (spec §9.4).
 * The window at index i is values[i-period .. i-1], so the result for the
 * first `period` indices is null.
 */

export function rollingHigh(
  values: readonly number[],
  period: number,
): Array<number | null> {
  if (period < 1) {
    throw new Error("rollingHigh: period must be >= 1");
  }
  const n = values.length;
  const out: Array<number | null> = new Array<number | null>(n).fill(null);
  for (let i = period; i < n; i += 1) {
    let m = -Infinity;
    for (let j = i - period; j < i; j += 1) {
      const v = values[j] ?? -Infinity;
      if (v > m) {
        m = v;
      }
    }
    out[i] = m;
  }
  return out;
}

export function rollingLow(
  values: readonly number[],
  period: number,
): Array<number | null> {
  if (period < 1) {
    throw new Error("rollingLow: period must be >= 1");
  }
  const n = values.length;
  const out: Array<number | null> = new Array<number | null>(n).fill(null);
  for (let i = period; i < n; i += 1) {
    let m = Infinity;
    for (let j = i - period; j < i; j += 1) {
      const v = values[j] ?? Infinity;
      if (v < m) {
        m = v;
      }
    }
    out[i] = m;
  }
  return out;
}

/**
 * For each value, return its percentile rank (0..1) within the trailing
 * `window` values *including* the current one. Used by the strategies to
 * gauge whether the current ATR is unusually high or low relative to the
 * recent past.
 *
 * Percentile rank uses the "fraction of values <= current" convention.
 */
export function atrPercentile(
  values: readonly (number | null)[],
  window: number,
): Array<number | null> {
  if (window < 1) {
    throw new Error("atrPercentile: window must be >= 1");
  }
  const n = values.length;
  const out: Array<number | null> = new Array<number | null>(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    const cur = values[i];
    if (cur === null || cur === undefined) {
      continue;
    }
    const start = Math.max(0, i - window + 1);
    let countLE = 0;
    let count = 0;
    for (let j = start; j <= i; j += 1) {
      const v = values[j];
      if (v === null || v === undefined) {
        continue;
      }
      count += 1;
      if (v <= cur) {
        countLE += 1;
      }
    }
    if (count < window) {
      continue;
    }
    out[i] = countLE / count;
  }
  return out;
}

/**
 * Past return: at index i, (close[i] - close[i - bars]) / close[i - bars].
 * Returns null until enough history exists; null also when the prior close
 * is exactly zero (would divide by zero).
 */
export function pastReturn(
  closes: readonly number[],
  bars: number,
): Array<number | null> {
  if (bars < 1) {
    throw new Error("pastReturn: bars must be >= 1");
  }
  const n = closes.length;
  const out: Array<number | null> = new Array<number | null>(n).fill(null);
  for (let i = bars; i < n; i += 1) {
    const cur = closes[i];
    const prev = closes[i - bars];
    if (cur === undefined || prev === undefined || prev === 0) {
      continue;
    }
    out[i] = (cur - prev) / prev;
  }
  return out;
}
