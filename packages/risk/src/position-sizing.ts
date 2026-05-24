/**
 * Position sizing per spec §9.10 T10.5.
 *
 *   dollar_risk    = account_equity * (riskPerTradePct / 100)
 *   stop_distance  = |entry - stop|
 *   pip_value      = standard-lot-units * pip_size for USD-quote pairs
 *   lot_size       = dollar_risk / (stop_distance * pip_value_per_lot_in_usd)
 *
 * If current drawdown > drawdownSoftReducePct, lot_size is halved.
 * Rounded to 0.01-lot increments. Below 0.01 returns 0.
 */

import { lotStep, standardLotUnits, type RiskConfig, type Signal } from "@trading/core";

/**
 * Per-unit USD value for one standard lot: the risk USD per lot for a given
 * stop distance equals stop_distance_in_price * standard_lot_units.
 */
function valuePerUnit(instrument: string): number {
  return standardLotUnits(instrument);
}

export interface SizingArgs {
  signal: Signal;
  accountEquityUsd: number;
  riskConfig: RiskConfig;
  /** Negative number (e.g. -0.12 for -12%); positive is up-from-peak. */
  currentDrawdownPct: number;
}

export function computeLotSize(args: SizingArgs): number {
  const { signal, accountEquityUsd, riskConfig } = args;
  if (accountEquityUsd <= 0) {
    return 0;
  }
  const dollarRisk = accountEquityUsd * (riskConfig.riskPerTradePct / 100);
  const stopDistance = Math.abs(signal.proposedEntryPrice - signal.proposedStopPrice);
  if (stopDistance <= 0) {
    return 0;
  }
  const valuePerLot = stopDistance * valuePerUnit(signal.instrument);
  if (valuePerLot <= 0) {
    return 0;
  }
  let lotSize = dollarRisk / valuePerLot;

  // Spec §9.10 — soft reduce: at any drawdown deeper than the threshold,
  // halve the size. Drawdown is recorded as a positive percentage; convert
  // accordingly.
  const ddPct = Math.abs(args.currentDrawdownPct);
  if (ddPct > riskConfig.drawdownSoftReducePct) {
    lotSize *= 0.5;
  }

  // Round to the instrument's lot step, drop sub-minimum.
  const step = lotStep(signal.instrument);
  lotSize = Math.round(lotSize / step) * step;
  if (lotSize < step) {
    return 0;
  }
  return lotSize;
}

/** Risk in USD that an order with given lot size + stop distance carries. */
export function riskUsdForOrder(
  instrument: string,
  entryPrice: number,
  stopPrice: number,
  lotSize: number,
): number {
  const distance = Math.abs(entryPrice - stopPrice);
  return distance * valuePerUnit(instrument) * lotSize;
}
