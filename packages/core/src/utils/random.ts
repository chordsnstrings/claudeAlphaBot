/**
 * Tiny seeded RNG (Mulberry32) + a normal-distribution sampler built on it.
 *
 * Used by the FrictionModel for spread/slippage sampling. Deterministic so
 * a backtest with the same seed produces identical fills bar-for-bar.
 *
 * Mulberry32 reference: https://stackoverflow.com/a/47593316 — 32-bit
 * state, period 2^32, passes most basic statistical tests, more than
 * enough for friction sampling. Quality > quantity here.
 */

export interface SeededRng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max). */
  nextInt(min: number, max: number): number;
  /** Uniform in [min, max). */
  nextRange(min: number, max: number): number;
  /** Normal (mean, stddev) via Box-Muller; uses two next() calls. */
  nextNormal(mean: number, stddev: number): number;
  /** Current 32-bit state (for debugging / save-restore). */
  readonly state: number;
}

export function mulberry32(seed: number): SeededRng {
  // Coerce to 32-bit unsigned; bigint seeds can be passed in via low 32.
  let s = seed >>> 0;
  let cachedGaussian: number | null = null;

  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const nextNormal = (mean: number, stddev: number): number => {
    if (cachedGaussian !== null) {
      const v = cachedGaussian;
      cachedGaussian = null;
      return mean + stddev * v;
    }
    // Box-Muller. Reject u1=0 to avoid log(0).
    let u1 = next();
    while (u1 === 0) {
      u1 = next();
    }
    const u2 = next();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    cachedGaussian = r * Math.sin(theta);
    return mean + stddev * (r * Math.cos(theta));
  };

  return {
    next,
    nextInt(min, max) {
      return Math.floor(min + next() * (max - min));
    },
    nextRange(min, max) {
      return min + next() * (max - min);
    },
    nextNormal,
    get state() {
      return s;
    },
  };
}

/** Reduce a bigint seed to the 32 bits the RNG wants. */
export function seedFromBigint(seed: bigint): number {
  return Number(seed & 0xffffffffn);
}
