/**
 * Veto layer — gates that veto or scale a SignalIntent before risk sizing.
 *
 * Sits between strategy evaluation and position sizing:
 *
 *   strategy.evaluate() → SignalIntent
 *     → vetoLayer.evaluate(intent, context) → VetoDecision (PASS / VETO / SCALE)
 *       → if PASS or SCALE: risk.sizePosition(...)
 *
 * Five sub-vetoes per CLAUDE_CODE_PROMPT phase 11:
 *
 *   1. **HTF bias** — block mean-reversion shorts when 4H trending up,
 *      block MR longs during 4H lower-band walking. Computed from the
 *      caller-provided 4H candles (resampled from 1H upstream).
 *
 *   2. **Funding gate** — when funding rate is elevated (≥ 0.05%) but
 *      *not opposing* the trade direction (i.e. positive funding on a
 *      LONG, negative funding on a SHORT — you'd be PAYING funding),
 *      reduce leverage by half. When opposing (you'd be receiving
 *      funding), no change.
 *
 *   3. **OI spike gate** — block entry if open interest jumped > 10%
 *      in the last hour (signals frothy positioning + reversal risk).
 *
 *   4. **Correlation cap** — BTC/ETH/SOL share ONE bucket (spec §6.5).
 *      Max 2 positions in the bucket. The cap is the hard ceiling on
 *      *count*; sizing-time exposure cap (notional) is in `risk.ts`.
 *
 *   5. **Volatility spike pause** — spec §9.8: if the previous 1H bar
 *      moved > 10%, pause new entries for 2 hours.
 *
 * The veto layer is intentionally separate from the per-strategy SKIP
 * reasons because vetoes are *cross-cutting* — they look at portfolio
 * state, HTF context, and exchange data the strategy itself doesn't
 * see. Each veto returns a structured reason so the UI / journal can
 * display *which* veto fired.
 */
import type {
  Candle,
  FundingRate,
  OpenPosition,
  SignalIntent,
  StrategyName,
  Symbol as TradingSymbol,
} from "@hydra/shared";

import { ema } from "./indicators.js";

const HOUR_MS = 3_600_000;

export const DEFAULT_VETO_HTF_EMA_PERIOD = 50;
export const DEFAULT_VETO_HTF_MIN_BARS = 60;
export const DEFAULT_VETO_FUNDING_ELEVATED = 0.0005; // 0.05%
export const DEFAULT_VETO_FUNDING_LEVERAGE_DAMPING = 0.5;
export const DEFAULT_VETO_OI_SPIKE_PCT = 10;
export const DEFAULT_VETO_VOL_SPIKE_PCT = 10;
export const DEFAULT_VETO_VOL_SPIKE_PAUSE_HOURS = 2;
export const DEFAULT_VETO_CORRELATION_BUCKET_MAX = 2;

/** Mean-reversion strategies — these are the ones HTF bias affects. */
const MR_STRATEGIES: ReadonlySet<StrategyName> = new Set<StrategyName>([
  "WEEKEND_MR",
  "BB_MR",
  "FUNDING_FADE",
]);

export interface VetoOptions {
  readonly htfEmaPeriod?: number;
  readonly htfMinBars?: number;
  readonly fundingElevatedAbs?: number;
  readonly fundingLeverageDamping?: number;
  readonly oiSpikePct?: number;
  readonly volSpikePct?: number;
  readonly volSpikePauseHours?: number;
  readonly correlationBucketMax?: number;
}

export interface VetoInputs {
  readonly intent: SignalIntent;
  /**
   * 4H candles (oldest → newest) for the same symbol — caller is
   * responsible for resampling 1H bars upstream. Optional: if absent
   * or too short, HTF bias is skipped (returns PASS for that check).
   */
  readonly htfCandles?: readonly Candle[];
  /** Most recent funding rate for this symbol (or null/undefined). */
  readonly currentFunding?: FundingRate | null;
  /**
   * Open-interest samples (oldest → newest), each `{t, oi}` in USD
   * notional. We compute the 1-hour change.
   */
  readonly openInterestSeries?: readonly { readonly t: number; readonly oi: number }[];
  /** Currently-open positions across the portfolio. */
  readonly openPositions: readonly OpenPosition[];
  /** Recent 1H candles for THIS symbol — used for vol-spike pause (last 3 hours). */
  readonly recentCandles: readonly Candle[];
  readonly nowUtc: number;
  readonly opts?: VetoOptions;
}

export type VetoReason =
  | "HTF_BIAS_AGAINST"
  | "VOL_SPIKE_PAUSE"
  | "OI_SPIKE"
  | "CORRELATION_CAP"
  | "FUNDING_PENALTY";

export interface VetoPass {
  readonly type: "PASS";
}
export interface VetoBlock {
  readonly type: "VETO";
  readonly reason: VetoReason;
  readonly detail?: string;
}
export interface VetoScale {
  readonly type: "SCALE";
  /** Multiply the *desired notional* by this scalar before sizing (0 < f ≤ 1). */
  readonly notionalMultiplier: number;
  /** Why we scaled. */
  readonly reason: VetoReason;
  readonly detail?: string;
}

export type VetoDecision = VetoPass | VetoBlock | VetoScale;

/**
 * Run all sub-vetoes in a deterministic order. The first BLOCK wins;
 * otherwise the strongest SCALE applies (smallest multiplier).
 *
 * Order:
 *   1. Vol-spike pause (immediate hard block on anomaly bars)
 *   2. OI spike
 *   3. Correlation cap (count-based)
 *   4. HTF bias (only for MR strategies)
 *   5. Funding penalty (SCALE, not BLOCK)
 */
export function evaluateVetos(inputs: VetoInputs): VetoDecision {
  const checks: ((i: VetoInputs) => VetoDecision)[] = [
    checkVolSpike,
    checkOiSpike,
    checkCorrelationCap,
    checkHtfBias,
    checkFundingPenalty,
  ];
  let scale: VetoScale | null = null;
  for (const fn of checks) {
    const r = fn(inputs);
    if (r.type === "VETO") return r;
    if (r.type === "SCALE") {
      if (!scale || r.notionalMultiplier < scale.notionalMultiplier) {
        scale = r;
      }
    }
  }
  return scale ?? { type: "PASS" };
}

/** §9.8 — abrupt vol spike: if any of the last `pause_hours` 1H bars moved > spikePct%, pause. */
export function checkVolSpike(inputs: VetoInputs): VetoDecision {
  const pct = inputs.opts?.volSpikePct ?? DEFAULT_VETO_VOL_SPIKE_PCT;
  const pauseHours = inputs.opts?.volSpikePauseHours ?? DEFAULT_VETO_VOL_SPIKE_PAUSE_HOURS;
  if (pct <= 0 || pauseHours <= 0) return { type: "PASS" };
  const cutoff = inputs.nowUtc - pauseHours * HOUR_MS;
  for (let i = inputs.recentCandles.length - 1; i >= 0; i--) {
    const c = inputs.recentCandles[i]!;
    if (c.openTime < cutoff) break;
    if (c.symbol !== inputs.intent.symbol) continue;
    if (c.open <= 0) continue;
    const movePct = (Math.abs(c.high - c.low) / c.open) * 100;
    if (movePct > pct) {
      return {
        type: "VETO",
        reason: "VOL_SPIKE_PAUSE",
        detail: `bar@${c.openTime} move=${movePct.toFixed(2)}%`,
      };
    }
  }
  return { type: "PASS" };
}

/** OI jumped > opts.oiSpikePct% in the last hour → block. */
export function checkOiSpike(inputs: VetoInputs): VetoDecision {
  const pct = inputs.opts?.oiSpikePct ?? DEFAULT_VETO_OI_SPIKE_PCT;
  if (pct <= 0) return { type: "PASS" };
  const series = inputs.openInterestSeries;
  if (!series || series.length < 2) return { type: "PASS" };
  const last = series[series.length - 1]!;
  // find the sample closest to (last.t − 1h)
  const targetT = last.t - HOUR_MS;
  let prior: { readonly t: number; readonly oi: number } | undefined;
  for (let i = series.length - 2; i >= 0; i--) {
    const s = series[i]!;
    if (s.t <= targetT) {
      prior = s;
      break;
    }
  }
  if (!prior || prior.oi <= 0) return { type: "PASS" };
  const deltaPct = ((last.oi - prior.oi) / prior.oi) * 100;
  if (Math.abs(deltaPct) > pct) {
    return { type: "VETO", reason: "OI_SPIKE", detail: `${deltaPct.toFixed(2)}%` };
  }
  return { type: "PASS" };
}

/** §6.5 — BTC/ETH/SOL share one bucket; max 2 in the bucket. */
export function checkCorrelationCap(inputs: VetoInputs): VetoDecision {
  const max = inputs.opts?.correlationBucketMax ?? DEFAULT_VETO_CORRELATION_BUCKET_MAX;
  // All three supported symbols are in the same bucket.
  const bucketCount = inputs.openPositions.filter((p) => isMajorPair(p.symbol)).length;
  if (bucketCount >= max) {
    return {
      type: "VETO",
      reason: "CORRELATION_CAP",
      detail: `bucket has ${bucketCount}/${max}`,
    };
  }
  return { type: "PASS" };
}

function isMajorPair(s: TradingSymbol): boolean {
  return s === "BTCUSDT" || s === "ETHUSDT" || s === "SOLUSDT";
}

/**
 * HTF bias check (only for mean-reversion strategies).
 *
 * Compute a 4H EMA(opts.htfEmaPeriod) on the supplied 4H candles. The
 * sign and slope of this EMA defines the prevailing higher-timeframe
 * trend. Block:
 *   - SHORT MR signal  when HTF trending UP   (close > ema and rising)
 *   - LONG  MR signal  when HTF trending DOWN (close < ema and falling)
 *
 * "Lower-band walking" (the spec phrase) = price riding below the EMA
 * with a sustained downward slope; conceptually identical to "HTF
 * trending DOWN" for the purposes of vetoing MR longs.
 */
export function checkHtfBias(inputs: VetoInputs): VetoDecision {
  if (!MR_STRATEGIES.has(inputs.intent.strategy)) return { type: "PASS" };
  const period = inputs.opts?.htfEmaPeriod ?? DEFAULT_VETO_HTF_EMA_PERIOD;
  const minBars = inputs.opts?.htfMinBars ?? DEFAULT_VETO_HTF_MIN_BARS;
  const cs = inputs.htfCandles;
  if (!cs || cs.length < minBars) return { type: "PASS" };
  const closes = cs.map((c) => c.close);
  const emaArr = ema(closes, period);
  const i = closes.length - 1;
  const lastClose = closes[i]!;
  const lastEma = emaArr[i];
  const priorEma = emaArr[i - 5];
  if (lastEma === undefined || priorEma === undefined) return { type: "PASS" };
  if (!Number.isFinite(lastEma) || !Number.isFinite(priorEma)) return { type: "PASS" };
  const slopeUp = lastEma > priorEma;
  const slopeDown = lastEma < priorEma;
  const aboveEma = lastClose > lastEma;
  const belowEma = lastClose < lastEma;
  const trendingUp = aboveEma && slopeUp;
  const trendingDown = belowEma && slopeDown;
  if (inputs.intent.direction === "SHORT" && trendingUp) {
    return {
      type: "VETO",
      reason: "HTF_BIAS_AGAINST",
      detail: `HTF up: close=${lastClose.toFixed(2)} ema=${lastEma.toFixed(2)} slope+`,
    };
  }
  if (inputs.intent.direction === "LONG" && trendingDown) {
    return {
      type: "VETO",
      reason: "HTF_BIAS_AGAINST",
      detail: `HTF down: close=${lastClose.toFixed(2)} ema=${lastEma.toFixed(2)} slope-`,
    };
  }
  return { type: "PASS" };
}

/**
 * Funding penalty: when funding is elevated AND not opposing our
 * direction, scale leverage by `fundingLeverageDamping` (default 0.5).
 *
 * "Not opposing" means the trade would PAY funding:
 *   - LONG  + positive funding → LONG pays. BAD. → SCALE
 *   - SHORT + negative funding → SHORT pays. BAD. → SCALE
 *   - LONG  + negative funding → LONG receives. GOOD. → PASS
 *   - SHORT + positive funding → SHORT receives. GOOD. → PASS
 *
 * FUNDING_FADE strategy is exempt because it's already a funding-aware
 * strategy with its own sizing (§5).
 */
export function checkFundingPenalty(inputs: VetoInputs): VetoDecision {
  if (inputs.intent.strategy === "FUNDING_FADE") return { type: "PASS" };
  const elevated = inputs.opts?.fundingElevatedAbs ?? DEFAULT_VETO_FUNDING_ELEVATED;
  const damping = inputs.opts?.fundingLeverageDamping ?? DEFAULT_VETO_FUNDING_LEVERAGE_DAMPING;
  const f = inputs.currentFunding;
  if (!f || f.symbol !== inputs.intent.symbol) return { type: "PASS" };
  if (Math.abs(f.fundingRate) < elevated) return { type: "PASS" };
  const longPays = f.fundingRate > 0;
  const directionPays =
    (inputs.intent.direction === "LONG" && longPays) ||
    (inputs.intent.direction === "SHORT" && !longPays);
  if (!directionPays) return { type: "PASS" };
  return {
    type: "SCALE",
    notionalMultiplier: damping,
    reason: "FUNDING_PENALTY",
    detail: `rate=${(f.fundingRate * 100).toFixed(4)}% trade pays funding`,
  };
}
