/**
 * Spread sampling per spec §6.5.
 *
 *   spread_pips = max(min_spread, normal(mean * tod_mult * news_mult, std_dev))
 *
 * News window multiplier (§6.4): 5 + uniform(0, 5).
 * Time-of-day multiplier table is in `todMultiplier()` below (§6.3).
 */

import type { SeededRng } from "./rng.js";
import { spreadParamsFor, type FrictionProfileName } from "./profiles.js";

/** Spec §6.3 — UTC hour -> spread multiplier. */
export function todMultiplier(utcHour: number): number {
  // Bands are [00,07),[07,08),[08,16),[16,17),[17,21),[21,22),[22,23),[23,00).
  if (utcHour < 7) {return 1.2;}
  if (utcHour < 8) {return 1.1;}
  if (utcHour < 16) {return 1.0;}
  if (utcHour < 17) {return 1.0;}
  if (utcHour < 21) {return 1.1;}
  if (utcHour < 22) {return 1.5;}
  if (utcHour < 23) {return 2.0;}
  return 1.3;
}

export interface SampleSpreadArgs {
  instrument: string;
  profile: FrictionProfileName;
  /** Bar timestamp (UTC) — used for the time-of-day multiplier. */
  atUtc: Date;
  /** True if the bar falls inside the news window per `isInNewsWindow`. */
  isInNewsWindow: boolean;
  rng: SeededRng;
}

export interface SampledSpread {
  pips: number;
  todMult: number;
  newsMult: number;
}

/**
 * Returns the sampled spread in pips. Always >= min_spread and <= max
 * (the max cap is a sanity ceiling for absurd Gaussian tails).
 */
export function sampleSpread(args: SampleSpreadArgs): SampledSpread {
  const params = spreadParamsFor(args.instrument, args.profile);
  if (params.mean === 0 && params.stddev === 0) {
    return { pips: 0, todMult: 1, newsMult: 1 };
  }
  const tod = todMultiplier(args.atUtc.getUTCHours());
  const news = args.isInNewsWindow ? 5 + args.rng.nextRange(0, 5) : 1;
  const mean = params.mean * tod * news;
  const stddev = params.stddev;
  const raw = args.rng.nextNormal(mean, stddev);
  const clamped = Math.min(params.max * Math.max(news, 1), Math.max(params.min, raw));
  return { pips: clamped, todMult: tod, newsMult: news };
}
