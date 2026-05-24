/**
 * FrictionModel — composes spread + slippage + commission + swap per the
 * configured profile. Spec §6.
 *
 * Used by SimulatedExecutionAdapter; not invoked in live mode.
 *
 * The class is deterministic for a given RNG seed: every sample comes
 * from the seeded Mulberry32 in `rng.ts`, so a backtest re-run with the
 * same seed produces identical fills.
 */

import {
  isCryptoInstrument,
  standardLotUnits as standardLotUnitsFor,
  type Direction,
  type FrictionUsd,
  type OrderType,
} from "@trading/core";

import { commissionUsd } from "./commission.js";
import { isInNewsWindow, type LoadedNewsEvent } from "./news.js";
import { cryptoTradeCostBps, pipSize, type FrictionProfileName } from "./profiles.js";
import { mulberry32, seedFromBigint, type SeededRng } from "./rng.js";
import { applySlippage, sampleSlippagePips } from "./slippage.js";
import { sampleSpread } from "./spread.js";
import { swapForNight } from "./swap.js";

export interface FrictionAppliedFill {
  /** Cost-adjusted fill price (spread + slippage applied). */
  effectivePrice: number;
  /** Friction breakdown attributable to THIS fill (one side of the trade). */
  breakdown: FrictionUsd;
  /** Raw sampled spread (pips) — for audit/debug. */
  spreadPips: number;
  /** Raw sampled slippage (pips) — for audit/debug. */
  slippagePips: number;
}

export interface ApplyFillArgs {
  instrument: string;
  direction: Direction;
  orderType: OrderType;
  /** The "fair" price before any friction (e.g. bar.close or the stop level). */
  rawPrice: number;
  lotSize: number;
  /** Bar timestamp for time-of-day + news lookups. */
  atUtc: Date;
  /** ATR(14) at the bar; null while warming up. */
  atr14: number | null;
  /** Median ATR(14) over the trailing 60 bars; null while warming up. */
  medianAtr14_60d: number | null;
  side: "entry" | "exit";
}

export interface FrictionModelDeps {
  profile: FrictionProfileName;
  randomSeed: bigint;
  newsEvents: readonly LoadedNewsEvent[];
}

export class FrictionModel {
  private readonly rng: SeededRng;

  constructor(private readonly deps: FrictionModelDeps) {
    this.rng = mulberry32(seedFromBigint(deps.randomSeed));
  }

  /** True if `t` falls inside the +/-15-min news window per §6.4. */
  isNews(t: Date): boolean {
    return isInNewsWindow(this.deps.newsEvents, t.getTime());
  }

  /**
   * Apply spread + slippage + commission to a single fill. Returns the
   * cost-adjusted price and a friction breakdown.
   *
   * Note: the commission charged here is the per-side half ($3.50 per
   * standard lot for Pepperstone Razor). The round-turn $7 is recovered
   * when entry and exit are summed.
   */
  applyFill(args: ApplyFillArgs): FrictionAppliedFill {
    // Crypto perps: charge a deterministic all-in cost (taker fee + spread +
    // slippage) as a fraction of notional. The FX pip machinery can't express
    // a %-of-notional cost (a fixed pip value isn't proportional to price),
    // and being deterministic avoids the per-bar RNG path-sensitivity that
    // afflicts the Gaussian spread sampler.
    if (isCryptoInstrument(args.instrument)) {
      return this.applyCryptoFill(args);
    }

    const news = this.isNews(args.atUtc);

    const spread = sampleSpread({
      instrument: args.instrument,
      profile: this.deps.profile,
      atUtc: args.atUtc,
      isInNewsWindow: news,
      rng: this.rng,
    });

    const slipPips = sampleSlippagePips({
      orderType: args.orderType,
      isInNewsWindow: news,
      atr14: args.atr14,
      medianAtr14_60d: args.medianAtr14_60d,
      rng: this.rng,
      profile: this.deps.profile,
    });

    const ps = pipSize(args.instrument);
    // Half the spread is paid by each side of the trade.
    const halfSpreadPrice = (spread.pips / 2) * ps;
    const spreadAdjusted =
      args.side === "entry"
        ? args.direction === "long"
          ? args.rawPrice + halfSpreadPrice
          : args.rawPrice - halfSpreadPrice
        : args.direction === "long"
          ? args.rawPrice - halfSpreadPrice
          : args.rawPrice + halfSpreadPrice;

    const effectivePrice = applySlippage(
      spreadAdjusted,
      slipPips,
      ps,
      args.direction,
      args.side,
    );

    // USD cost attribution. For FX, the spread cost equals (spread_pips *
    // pip_size * lot_size * standard_lot_units). For Pepperstone a
    // standard lot is 100 000 units; the pip value in quote currency is
    // pipSize * 100 000. For USD-quote pairs that's directly USD; for
    // non-USD quote pairs the conversion is per §6.9 (deferred to a
    // future commit — for now USD-quote is the dominant set).
    const standardLotUnits = standardLotUnitsFor(args.instrument);
    const halfSpreadUsd = (spread.pips / 2) * ps * standardLotUnits * args.lotSize;
    const slippageUsd = slipPips * ps * standardLotUnits * args.lotSize;
    const commission = commissionUsd(args.lotSize, this.deps.profile, args.side);

    const breakdown: FrictionUsd = {
      spread: halfSpreadUsd,
      slippage: slippageUsd,
      commission,
      swap: 0,
    };

    return {
      effectivePrice,
      breakdown,
      spreadPips: spread.pips,
      slippagePips: slipPips,
    };
  }

  /**
   * Crypto-perp fill: a single deterministic cost = costBps × notional per
   * side, applied both as an adverse price adjustment (so realised P&L
   * reflects it) and recorded in the USD breakdown. notional = price × lotSize
   * (crypto lot-units = 1).
   */
  private applyCryptoFill(args: ApplyFillArgs): FrictionAppliedFill {
    const costBps = cryptoTradeCostBps(this.deps.profile);
    const costFraction = costBps / 10_000;
    const adverse = args.rawPrice * costFraction;
    // Entry pays up (long buys higher / short sells lower); exit pays the
    // same way against the position.
    const worseUp =
      (args.side === "entry" && args.direction === "long") ||
      (args.side === "exit" && args.direction === "short");
    const effectivePrice = worseUp ? args.rawPrice + adverse : args.rawPrice - adverse;
    const costUsd = args.rawPrice * costFraction * args.lotSize * standardLotUnitsFor(args.instrument);
    return {
      effectivePrice,
      breakdown: { spread: costUsd, slippage: 0, commission: 0, swap: 0 },
      spreadPips: 0,
      slippagePips: 0,
    };
  }

  /** Per-night swap USD; called by the adapter on each UTC rollover. */
  swap(
    instrument: string,
    direction: Direction,
    lotSize: number,
    rolloverUtc: Date,
    price: number,
  ): number {
    return swapForNight({
      instrument,
      direction,
      lotSize,
      rolloverUtc,
      price,
      profile: this.deps.profile,
    });
  }

  /** Current internal RNG state — useful for resuming runs. */
  get rngState(): number {
    return this.rng.state;
  }

  get profile(): FrictionProfileName {
    return this.deps.profile;
  }
}
