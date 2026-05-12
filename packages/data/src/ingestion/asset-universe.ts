/**
 * Spec section 14 — asset universe.
 *
 * `FULL_DAILY_UNIVERSE` is loaded once across the entire ingest:full run
 * at the d1 timeframe over 5 years.
 *
 * `M1_UNIVERSE` is the active trading subset; 6 months of M1 bars.
 */

export const FULL_DAILY_UNIVERSE: readonly string[] = [
  // FX majors
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "USDCHF",
  "AUDUSD",
  "USDCAD",
  "NZDUSD",
  // FX crosses
  "EURGBP",
  "EURJPY",
  "GBPJPY",
  "AUDJPY",
  "CADJPY",
  "CHFJPY",
  "NZDJPY",
  "EURCHF",
  "EURAUD",
  "EURCAD",
  "EURNZD",
  "GBPAUD",
  "GBPCAD",
  "GBPCHF",
  "GBPNZD",
  "AUDCAD",
  "AUDCHF",
  "AUDNZD",
  "CADCHF",
  "NZDCAD",
  "NZDCHF",
  // Metals
  "XAUUSD",
  "XAGUSD",
  // Energy
  "BRENTCMDUSD",
  "LIGHTCMDUSD",
  // Indices
  "USA500IDXUSD",
  "USATECHIDXUSD",
  "USA30IDXUSD",
  "DEUIDXEUR",
  "FRAIDXEUR",
  "JPNIDXJPY",
  "GBRIDXGBP",
  "AUSIDXAUD",
  "HKGIDXHKD",
  // Crypto
  "BTCUSD",
  "ETHUSD",
] as const;

export const M1_UNIVERSE: readonly string[] = [
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "USDCHF",
  "AUDUSD",
  "USDCAD",
  "XAUUSD",
  "BRENTCMDUSD",
] as const;

export const DEFAULT_DAILY_FROM = new Date("2020-01-01T00:00:00Z");
export const DEFAULT_DAILY_TO = new Date("2026-05-12T00:00:00Z");

export const DEFAULT_M1_FROM = new Date("2025-11-01T00:00:00Z");
export const DEFAULT_M1_TO = new Date("2026-05-12T00:00:00Z");
