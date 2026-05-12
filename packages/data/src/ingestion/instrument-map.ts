/**
 * Map the trading-system instrument IDs (uppercase, no separator — section
 * 4.3) to the codes used by `dukascopy-node`.
 *
 * Some symbols listed in spec section 14 do not exist as Dukascopy
 * instruments (e.g. SPXUSD, NSXUSD); the spec explicitly says to log and
 * skip those. `resolve()` returns null for unavailable instruments rather
 * than throwing so the ingestion driver can record a validation issue and
 * move on.
 */

/** Canonical map. Order is irrelevant; the file is grouped for readability. */
const MAP: Readonly<Record<string, string>> = {
  // FX majors (7)
  EURUSD: "eurusd",
  GBPUSD: "gbpusd",
  USDJPY: "usdjpy",
  USDCHF: "usdchf",
  AUDUSD: "audusd",
  USDCAD: "usdcad",
  NZDUSD: "nzdusd",

  // FX crosses (~20)
  EURGBP: "eurgbp",
  EURJPY: "eurjpy",
  GBPJPY: "gbpjpy",
  AUDJPY: "audjpy",
  CADJPY: "cadjpy",
  CHFJPY: "chfjpy",
  NZDJPY: "nzdjpy",
  EURCHF: "eurchf",
  EURAUD: "euraud",
  EURCAD: "eurcad",
  EURNZD: "eurnzd",
  GBPAUD: "gbpaud",
  GBPCAD: "gbpcad",
  GBPCHF: "gbpchf",
  GBPNZD: "gbpnzd",
  AUDCAD: "audcad",
  AUDCHF: "audchf",
  AUDNZD: "audnzd",
  CADCHF: "cadchf",
  NZDCAD: "nzdcad",
  NZDCHF: "nzdchf",

  // Metals (2)
  XAUUSD: "xauusd",
  XAGUSD: "xagusd",

  // Energy (2)
  BRENTCMDUSD: "brentcmdusd",
  LIGHTCMDUSD: "lightcmdusd",

  // Indices — the spec uses some friendly names that map onto Dukascopy's
  // actual codes. Indices Dukascopy does not carry are marked NOT_AVAILABLE
  // below.
  USA500IDXUSD: "usa500idxusd", // S&P 500 CFD (spec called SPXUSD)
  USATECHIDXUSD: "usatechidxusd", // Nasdaq 100 CFD (spec called NSXUSD)
  USA30IDXUSD: "usa30idxusd", // Dow Jones CFD
  DEUIDXEUR: "deuidxeur", // DAX 40 CFD
  FRAIDXEUR: "fraidxeur", // CAC 40 CFD
  JPNIDXJPY: "jpnidxjpy", // Nikkei 225 CFD
  GBRIDXGBP: "gbridxgbp", // FTSE 100 CFD
  AUSIDXAUD: "ausidxaud", // ASX 200 CFD
  HKGIDXHKD: "hkgidxhkd", // Hang Seng CFD

  // Crypto
  BTCUSD: "btcusd",
  ETHUSD: "ethusd",
};

/** Spec aliases that map to the canonical codes above. */
const ALIASES: Readonly<Record<string, keyof typeof MAP>> = {
  SPXUSD: "USA500IDXUSD",
  NSXUSD: "USATECHIDXUSD",
};

/** Instruments listed in spec section 14 that Dukascopy does not carry. */
const NOT_AVAILABLE: ReadonlySet<string> = new Set<string>([
  // (none currently — leave the hook for future spec edits)
]);

export interface ResolveResult {
  /** Canonical trading-system instrument code (always upper-cased). */
  canonical: string;
  /** dukascopy-node lowercase code. `null` when the symbol is not available. */
  dukascopy: string | null;
}

export function resolve(input: string): ResolveResult {
  const upper = input.trim().toUpperCase();
  if (NOT_AVAILABLE.has(upper)) {
    return { canonical: upper, dukascopy: null };
  }
  const aliased = (ALIASES[upper] ?? upper) as keyof typeof MAP;
  const code = MAP[aliased];
  if (code === undefined) {
    return { canonical: upper, dukascopy: null };
  }
  return { canonical: aliased, dukascopy: code };
}

export function listKnownInstruments(): string[] {
  return Object.keys(MAP).sort();
}
