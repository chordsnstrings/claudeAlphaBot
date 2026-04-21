/**
 * Validation snapshot capture per spec §8.12.1.
 *
 * Called by the validation pipeline (Phase 12) at the moment a
 * `validated_config.json` artifact is produced. Captures a point-in-
 * time picture of market conditions across all three symbols + a
 * BTC realized-vol global.
 *
 * The snapshot is the baseline that future drift monitor checks
 * compare against (spec §8.12.2). One snapshot per artifact_hash;
 * stored alongside the artifact.
 */
import type {
  Candle,
  Symbol as TradingSymbol,
  SymbolSnapshot,
  ValidationSnapshot,
} from "@hydra/shared";
import { SYMBOLS } from "@hydra/shared";

import { classifyRegime, type RegimeClassifierOptions } from "./regime.js";

const HOUR_MS = 3_600_000;

export interface CaptureSnapshotInputs {
  readonly artifactHash: string;
  /** Map of symbol → candles (oldest → newest, must end at validation moment). */
  readonly candlesBySymbol: ReadonlyMap<TradingSymbol, readonly Candle[]>;
  readonly nowUtc: number;
  /** Optional overrides for the regime classifier. */
  readonly classifierOpts?: RegimeClassifierOptions;
  readonly notes?: string;
}

export function captureValidationSnapshot(
  inputs: CaptureSnapshotInputs,
): ValidationSnapshot {
  const perSymbol: SymbolSnapshot[] = [];
  for (const symbol of SYMBOLS) {
    const candles = inputs.candlesBySymbol.get(symbol);
    if (!candles || candles.length === 0) {
      perSymbol.push({
        symbol,
        regime: "RANGING",
        confidence: 0,
        bbWidthPercentile: Number.NaN,
        ema99Slope: Number.NaN,
        atrPct: Number.NaN,
      });
      continue;
    }
    const r = classifyRegime(candles, inputs.classifierOpts ?? {});
    perSymbol.push({
      symbol,
      regime: r.regime,
      confidence: r.confidence,
      bbWidthPercentile: r.bbWidthPctile,
      ema99Slope: r.ema99SlopePct,
      atrPct: r.atrPct,
    });
  }

  const btcCandles = inputs.candlesBySymbol.get("BTCUSDT") ?? [];
  const btcRealizedVol30d = realizedVolatilityAnnualized(btcCandles, 30 * 24);

  const snap: ValidationSnapshot = {
    artifactHash: inputs.artifactHash,
    createdAtUtc: inputs.nowUtc,
    perSymbol,
    btcRealizedVol30d,
    ...(inputs.notes ? { notes: inputs.notes } : {}),
  };
  return snap;
}

/**
 * Annualized realized volatility from log returns over the trailing
 * `window` 1H bars. Annualization factor = √(365 × 24).
 *
 * Returns NaN when there isn't enough data.
 */
export function realizedVolatilityAnnualized(
  candles: readonly Candle[],
  windowBars: number,
): number {
  if (candles.length < windowBars + 1) return Number.NaN;
  const start = candles.length - windowBars - 1;
  const rets: number[] = [];
  for (let i = start + 1; i < candles.length; i++) {
    const a = candles[i - 1]!;
    const b = candles[i]!;
    if (a.close <= 0 || b.close <= 0) continue;
    rets.push(Math.log(b.close / a.close));
  }
  if (rets.length === 0) return Number.NaN;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) * (x - mean), 0) / rets.length;
  const sd = Math.sqrt(variance);
  return sd * Math.sqrt(365 * 24);
}

void HOUR_MS;
