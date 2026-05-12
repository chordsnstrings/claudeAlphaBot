/**
 * Wilson 95% confidence interval for a binomial proportion (spec §8.4).
 *
 *   z = 1.96 for 95%
 *   center = (p + z²/(2n)) / (1 + z²/n)
 *   margin = z × sqrt(p(1-p)/n + z²/(4n²)) / (1 + z²/n)
 */

export interface ProportionCi {
  point: number;
  lower: number;
  upper: number;
}

export function wilsonCi(
  successes: number,
  trials: number,
  z = 1.96,
): ProportionCi {
  if (trials <= 0) {
    return { point: 0, lower: 0, upper: 0 };
  }
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const inner = (p * (1 - p)) / trials + z2 / (4 * trials * trials);
  const margin = (z * Math.sqrt(inner)) / denom;
  return {
    point: p,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}
