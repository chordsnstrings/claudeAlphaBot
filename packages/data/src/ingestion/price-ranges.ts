/**
 * Per-instrument plausible price ranges, used by the magnitude validator.
 * The bounds are intentionally loose (5x widening on each side) so daily
 * volatility doesn't trip the check — only structurally wrong values do
 * (e.g. EURUSD parsed as 1,180,000 instead of 1.18).
 *
 * Returns null for instruments with no expected range (e.g. indices that
 * differ wildly by venue); the validator treats those as "skip magnitude".
 */

const RANGES: Readonly<Record<string, readonly [number, number]>> = {
  // USD-quoted FX
  EURUSD: [0.8, 1.8],
  GBPUSD: [1.0, 2.0],
  AUDUSD: [0.5, 1.2],
  NZDUSD: [0.4, 1.1],
  USDCHF: [0.5, 1.5],
  USDCAD: [0.9, 1.8],
  // JPY-quoted
  USDJPY: [70, 200],
  EURJPY: [80, 220],
  GBPJPY: [100, 280],
  AUDJPY: [50, 130],
  CADJPY: [50, 150],
  CHFJPY: [80, 200],
  NZDJPY: [40, 130],
  // Non-JPY crosses
  EURGBP: [0.6, 1.1],
  EURCHF: [0.7, 1.4],
  EURAUD: [1.2, 2.0],
  EURCAD: [1.2, 2.0],
  EURNZD: [1.4, 2.2],
  GBPAUD: [1.5, 2.5],
  GBPCAD: [1.4, 2.2],
  GBPCHF: [0.9, 1.6],
  GBPNZD: [1.6, 2.6],
  AUDCAD: [0.7, 1.2],
  AUDCHF: [0.5, 1.0],
  AUDNZD: [1.0, 1.3],
  CADCHF: [0.6, 1.0],
  NZDCAD: [0.7, 1.1],
  NZDCHF: [0.4, 0.9],
  // Metals
  XAUUSD: [1500, 6000],
  XAGUSD: [10, 80],
  // Energy
  BRENTCMDUSD: [20, 200],
  LIGHTCMDUSD: [10, 200],
  // Crypto
  BTCUSD: [1_000, 250_000],
  ETHUSD: [100, 20_000],
};

export function expectedRange(canonical: string): readonly [number, number] | null {
  return RANGES[canonical] ?? null;
}
