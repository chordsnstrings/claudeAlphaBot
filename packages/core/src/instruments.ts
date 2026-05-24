/**
 * Single source of truth for per-instrument contract conventions. Four
 * call-sites (risk sizing, friction model, simulated execution P&L, the
 * research orchestrator's leverage cap) previously each hard-coded their own
 * copy of these constants; any drift between them silently corrupts P&L. They
 * all import from here.
 *
 * Instrument code conventions:
 *   FX majors / metals / oil  ->  XXXUSD  (e.g. EURUSD, XAUUSD, BRENTCMDUSD)
 *   Crypto perpetual futures  ->  XXXUSDT (e.g. BTCUSDT, ETHUSDT) — the
 *     USDT-margined convention, which also cleanly distinguishes crypto from
 *     FX so sizing/friction can branch on it.
 */

/** Crypto perps use the USDT-margined code convention (e.g. BTCUSDT). */
export function isCryptoInstrument(instrument: string): boolean {
  return instrument.endsWith("USDT");
}

/**
 * Contract units per 1.0 lot.
 *   FX standard lot  = 100 000 base units
 *   XAUUSD           = 100 oz
 *   XAGUSD           = 5 000 oz
 *   Brent / WTI      = 100 bbl
 *   Crypto perp      = 1 coin (1 lot = 1 unit of the base asset)
 */
export function standardLotUnits(instrument: string): number {
  if (isCryptoInstrument(instrument)) {
    return 1;
  }
  switch (instrument) {
    case "XAUUSD":
      return 100;
    case "XAGUSD":
      return 5000;
    case "BRENTCMDUSD":
    case "LIGHTCMDUSD":
      return 100;
    default:
      return 100_000;
  }
}

/**
 * Minimum lot increment. FX trades in micro-lots (0.01). Crypto perps are
 * effectively continuous (exchanges quote down to ~1e-3 coin or finer), so we
 * round to 1e-6 — fine enough that the lot step never distorts risk sizing for
 * a high-priced asset like BTC.
 */
export function lotStep(instrument: string): number {
  return isCryptoInstrument(instrument) ? 1e-6 : 0.01;
}
