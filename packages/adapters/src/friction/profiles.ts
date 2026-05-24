/**
 * Friction profile data per spec §6 — three named profiles plus the
 * per-instrument tables. Lookups are keyed by canonical (uppercase)
 * instrument codes per the trading-system §4.3 naming.
 */

import type { Direction } from "@trading/core";

export type FrictionProfileName =
  | "pepperstone_razor"
  | "zero_friction"
  | "pessimistic";

export interface SpreadParams {
  /** Mean spread in pips. */
  mean: number;
  /** Standard deviation in pips. */
  stddev: number;
  /** Minimum allowed spread (after sampling clamp). */
  min: number;
  /** Maximum allowed spread (for sanity bounds). */
  max: number;
}

export interface SwapParams {
  /** Per-night USD on the long side per standard lot. */
  long: number;
  /** Per-night USD on the short side per standard lot. */
  short: number;
}

// ---------------------------------------------------------------- spreads

const PEPPERSTONE_SPREADS: Record<string, SpreadParams> = {
  EURUSD: { mean: 0.15, stddev: 0.1, min: 0.0, max: 0.5 },
  GBPUSD: { mean: 0.25, stddev: 0.15, min: 0.0, max: 0.8 },
  USDJPY: { mean: 0.2, stddev: 0.1, min: 0.1, max: 0.5 },
  USDCHF: { mean: 0.3, stddev: 0.15, min: 0.1, max: 0.8 },
  AUDUSD: { mean: 0.25, stddev: 0.15, min: 0.0, max: 0.7 },
  USDCAD: { mean: 0.3, stddev: 0.2, min: 0.1, max: 0.9 },
  NZDUSD: { mean: 0.35, stddev: 0.2, min: 0.1, max: 1.0 },
  EURJPY: { mean: 0.5, stddev: 0.25, min: 0.2, max: 1.2 },
  GBPJPY: { mean: 0.8, stddev: 0.4, min: 0.3, max: 2.0 },
  EURGBP: { mean: 0.4, stddev: 0.2, min: 0.1, max: 1.0 },
  XAUUSD: { mean: 12, stddev: 8, min: 5, max: 40 },
  XAGUSD: { mean: 25, stddev: 12, min: 10, max: 60 },
  BRENTCMDUSD: { mean: 3, stddev: 2, min: 1, max: 10 },
  LIGHTCMDUSD: { mean: 3, stddev: 2, min: 1, max: 10 },
};

const DEFAULT_SPREAD: SpreadParams = { mean: 0.4, stddev: 0.25, min: 0.1, max: 1.0 };

export function spreadParamsFor(
  instrument: string,
  profile: FrictionProfileName,
): SpreadParams {
  if (profile === "zero_friction") {
    return { mean: 0, stddev: 0, min: 0, max: 0 };
  }
  const base = PEPPERSTONE_SPREADS[instrument] ?? DEFAULT_SPREAD;
  if (profile === "pessimistic") {
    return {
      mean: base.mean * 1.5,
      stddev: base.stddev * 1.5,
      min: base.min,
      max: base.max * 1.5,
    };
  }
  return base;
}

// ----------------------------------------------------------------- swaps

const PEPPERSTONE_SWAPS: Record<string, SwapParams> = {
  EURUSD: { long: -5.5, short: 1.2 },
  GBPUSD: { long: -4.2, short: 0.8 },
  USDJPY: { long: 3.5, short: -7.2 },
  USDCHF: { long: 2.1, short: -5.8 },
  AUDUSD: { long: -3.8, short: 0.5 },
  USDCAD: { long: 1.5, short: -4.5 },
  NZDUSD: { long: -3.2, short: 0.4 },
  EURJPY: { long: -2.0, short: -3.5 },
  GBPJPY: { long: -1.5, short: -3.0 },
  EURGBP: { long: -1.8, short: -0.5 },
  XAUUSD: { long: -6.5, short: -5.2 },
  XAGUSD: { long: -2.5, short: -1.8 },
  BRENTCMDUSD: { long: -2.8, short: -2.2 },
  LIGHTCMDUSD: { long: -2.8, short: -2.2 },
};

const DEFAULT_SWAP: SwapParams = { long: -3.0, short: -3.0 };

export function swapParamsFor(
  instrument: string,
  profile: FrictionProfileName,
): SwapParams {
  if (profile === "zero_friction") {
    return { long: 0, short: 0 };
  }
  const base = PEPPERSTONE_SWAPS[instrument] ?? DEFAULT_SWAP;
  if (profile === "pessimistic") {
    return { long: base.long * 1.5, short: base.short * 1.5 };
  }
  return base;
}

export function swapValueForDirection(
  params: SwapParams,
  direction: Direction,
): number {
  return direction === "long" ? params.long : params.short;
}

// ------------------------------------------------------------ commissions

/** Spec §6.7 — Pepperstone Razor: $7 per round-turn standard lot. */
export const PEPPERSTONE_COMMISSION_PER_RT_LOT_USD = 7.0;

export function commissionMultiplier(profile: FrictionProfileName): number {
  switch (profile) {
    case "zero_friction":
      return 0;
    case "pessimistic":
      return 1.2;
    case "pepperstone_razor":
      return 1.0;
    default: {
      const exhaustive: never = profile;
      throw new Error(`commissionMultiplier: unhandled profile ${String(exhaustive)}`);
    }
  }
}

// --------------------------------------------------------------- slippage

export function slippageMultiplier(profile: FrictionProfileName): number {
  switch (profile) {
    case "zero_friction":
      return 0;
    case "pessimistic":
      return 2.0;
    case "pepperstone_razor":
      return 1.0;
    default: {
      const exhaustive: never = profile;
      throw new Error(`slippageMultiplier: unhandled profile ${String(exhaustive)}`);
    }
  }
}

// ------------------------------------------------------------ crypto perps

/**
 * All-in per-side trade cost for crypto perps, in basis points of notional
 * (taker fee + spread + slippage). Liquid majors (BTC/ETH) run ~4–5 bps taker
 * + ~1–2 bps spread/slippage; 6 bps/side (12 bps round-turn) is a touch
 * conservative for majors and roughly fair for the larger alts.
 */
export function cryptoTradeCostBps(profile: FrictionProfileName): number {
  switch (profile) {
    case "zero_friction":
      return 0;
    case "pessimistic":
      return 12;
    case "pepperstone_razor":
      return 6;
    default: {
      const exhaustive: never = profile;
      throw new Error(`cryptoTradeCostBps: unhandled profile ${String(exhaustive)}`);
    }
  }
}

/**
 * Daily funding/borrow drag for a held crypto-perp position, in basis points
 * of notional, charged to BOTH directions. A trend follower is long in bull
 * regimes (when funding is typically positive → longs pay) and short in bear
 * regimes (funding negative → shorts pay), so funding is ~always a cost for
 * momentum. 1 bp/day ≈ 3.65%/yr is a conservative average of historical perp
 * funding; spikes ran higher, calm periods lower.
 */
export function cryptoFundingDailyBps(profile: FrictionProfileName): number {
  switch (profile) {
    case "zero_friction":
      return 0;
    case "pessimistic":
      return 2;
    case "pepperstone_razor":
      return 1;
    default: {
      const exhaustive: never = profile;
      throw new Error(`cryptoFundingDailyBps: unhandled profile ${String(exhaustive)}`);
    }
  }
}

// --------------------------------------------------------------- pip size

/**
 * Pip size in price units for the given instrument. Defaults to 0.0001
 * (4-decimal FX); JPY-quoted FX, precious metals, and oil all get 0.01.
 *
 * Indices and crypto fall back to 0.01 — they aren't covered by the spec
 * §6 spread tables (their friction default to the "unlisted" row).
 */
export function pipSize(instrument: string): number {
  if (instrument.endsWith("JPY")) {
    return 0.01;
  }
  if (
    instrument === "XAUUSD" ||
    instrument === "XAGUSD" ||
    instrument === "BRENTCMDUSD" ||
    instrument === "LIGHTCMDUSD"
  ) {
    return 0.01;
  }
  return 0.0001;
}
