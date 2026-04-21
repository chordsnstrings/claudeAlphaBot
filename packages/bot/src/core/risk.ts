/**
 * Risk module per spec §6: position sizing, leverage, exposure caps,
 * minimum-notional + step-size rounding.
 *
 * All math is pure: callers pass the current account snapshot and a
 * symbol meta record (step size + min qty); the function returns a
 * sized result or a machine-readable reject reason.
 *
 * Sizing formula (§6.2):
 *   risk_usd          = equity × risk_pct
 *   stop_distance     = |entry − stop|
 *   raw_notional      = risk_usd / (stop_distance / entry)
 *   raw_qty           = raw_notional / entry
 *   qty               = floor(raw_qty / step) × step      // never round up
 *   notional          = qty × entry
 *   margin            = notional / leverage
 *
 * Exposure cap (§6.5):
 *   max_notional_total = 2.5 × equity
 *   headroom           = max_notional_total − Σ(open_notionals)
 *   if desired ≤ headroom: enter full
 *   elif headroom / desired ≥ 0.2: scale down to headroom
 *   else: REJECT
 */
import type { Symbol as TradingSymbol } from "@hydra/shared";

export const DEFAULT_RISK_PCT = 0.02;
export const DEFAULT_LEVERAGE = 20;
export const DEFAULT_MAX_NOTIONAL_MULTIPLE = 2.5;
export const DEFAULT_MIN_NOTIONAL_USD = 5;
export const DEFAULT_PARTIAL_FILL_THRESHOLD = 0.2;

export interface SymbolMeta {
  readonly symbol: TradingSymbol;
  readonly stepSize: number; // quantity rounding (e.g. 0.001 for BTCUSDT)
  readonly minQty: number;   // exchange minimum quantity
}

export interface RiskOptions {
  readonly riskPct?: number;
  readonly leverage?: number;
  readonly maxNotionalMultiple?: number;
  readonly minNotionalUsd?: number;
  readonly partialFillThreshold?: number;
}

export interface SizingInputs {
  readonly accountEquity: number;
  readonly entryPrice: number;
  readonly stopPrice: number;
  /** Sum of NOTIONAL across all currently-open positions. */
  readonly openNotionalsSum: number;
  readonly symbolMeta: SymbolMeta;
  readonly opts?: RiskOptions;
}

export type SizingRejectReason =
  | "ZERO_STOP_DISTANCE"
  | "BELOW_MIN_NOTIONAL"
  | "BELOW_MIN_QTY"
  | "QUANTITY_ROUNDS_TO_ZERO"
  | "EXPOSURE_HEADROOM_TOO_SMALL";

export interface SizingOk {
  readonly type: "OK";
  readonly quantity: number;
  readonly notionalUsd: number;
  readonly riskUsd: number;
  readonly marginUsd: number;
  readonly leverage: number;
  readonly partial: boolean;
}

export type SizingResult = SizingOk | { readonly type: "REJECT"; readonly reason: SizingRejectReason };

export function sizePosition(inputs: SizingInputs): SizingResult {
  const opts = inputs.opts ?? {};
  const riskPct = opts.riskPct ?? DEFAULT_RISK_PCT;
  const leverage = opts.leverage ?? DEFAULT_LEVERAGE;
  const maxMul = opts.maxNotionalMultiple ?? DEFAULT_MAX_NOTIONAL_MULTIPLE;
  const minNotional = opts.minNotionalUsd ?? DEFAULT_MIN_NOTIONAL_USD;
  const partialThreshold = opts.partialFillThreshold ?? DEFAULT_PARTIAL_FILL_THRESHOLD;

  const stopDist = Math.abs(inputs.entryPrice - inputs.stopPrice);
  if (stopDist <= 0) return { type: "REJECT", reason: "ZERO_STOP_DISTANCE" };

  const riskUsd = inputs.accountEquity * riskPct;
  const desiredNotional = riskUsd / (stopDist / inputs.entryPrice);

  // Exposure cap (§6.5)
  const maxNotionalTotal = maxMul * inputs.accountEquity;
  const headroom = Math.max(0, maxNotionalTotal - inputs.openNotionalsSum);
  let targetNotional = desiredNotional;
  let partial = false;
  if (desiredNotional > headroom) {
    if (headroom <= 0 || headroom / desiredNotional < partialThreshold) {
      return { type: "REJECT", reason: "EXPOSURE_HEADROOM_TOO_SMALL" };
    }
    targetNotional = headroom;
    partial = true;
  }

  const rawQty = targetNotional / inputs.entryPrice;
  const step = inputs.symbolMeta.stepSize;
  const quantity = step > 0 ? Math.floor(rawQty / step) * step : rawQty;
  if (quantity <= 0) return { type: "REJECT", reason: "QUANTITY_ROUNDS_TO_ZERO" };
  if (quantity < inputs.symbolMeta.minQty) return { type: "REJECT", reason: "BELOW_MIN_QTY" };

  const notionalUsd = quantity * inputs.entryPrice;
  if (notionalUsd < minNotional) return { type: "REJECT", reason: "BELOW_MIN_NOTIONAL" };

  return {
    type: "OK",
    quantity,
    notionalUsd,
    riskUsd,
    marginUsd: notionalUsd / leverage,
    leverage,
    partial,
  };
}

/** Default per-symbol meta for the three supported pairs (Binance USDT-M perp). */
export const DEFAULT_SYMBOL_META: Readonly<Record<TradingSymbol, SymbolMeta>> = {
  BTCUSDT: { symbol: "BTCUSDT", stepSize: 0.001, minQty: 0.001 },
  ETHUSDT: { symbol: "ETHUSDT", stepSize: 0.001, minQty: 0.001 },
  SOLUSDT: { symbol: "SOLUSDT", stepSize: 1, minQty: 1 },
};
