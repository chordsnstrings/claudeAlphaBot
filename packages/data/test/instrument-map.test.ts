import { describe, expect, it } from "vitest";

import { listKnownInstruments, resolve } from "../src/ingestion/instrument-map.js";

describe("instrument map", () => {
  it("resolves canonical FX symbols", () => {
    expect(resolve("EURUSD").dukascopy).toBe("eurusd");
    expect(resolve("eurusd").dukascopy).toBe("eurusd");
    expect(resolve("  EURUSD ").dukascopy).toBe("eurusd");
    expect(resolve("EURUSD").canonical).toBe("EURUSD");
  });

  it("resolves metals + energy", () => {
    expect(resolve("XAUUSD").dukascopy).toBe("xauusd");
    expect(resolve("BRENTCMDUSD").dukascopy).toBe("brentcmdusd");
    expect(resolve("LIGHTCMDUSD").dukascopy).toBe("lightcmdusd");
  });

  it("applies spec aliases for indices", () => {
    // Spec lists SPXUSD/NSXUSD; Dukascopy uses usa500idxusd/usatechidxusd.
    const sp = resolve("SPXUSD");
    expect(sp.canonical).toBe("USA500IDXUSD");
    expect(sp.dukascopy).toBe("usa500idxusd");
    const nas = resolve("NSXUSD");
    expect(nas.canonical).toBe("USATECHIDXUSD");
    expect(nas.dukascopy).toBe("usatechidxusd");
  });

  it("returns null for unknown symbols", () => {
    expect(resolve("XYZUSD").dukascopy).toBeNull();
    expect(resolve("").dukascopy).toBeNull();
  });

  it("listKnownInstruments has all the spec section-14 categories", () => {
    const all = listKnownInstruments();
    expect(all).toContain("EURUSD");
    expect(all).toContain("XAUUSD");
    expect(all).toContain("BRENTCMDUSD");
    expect(all).toContain("BTCUSD");
    expect(all).toContain("USA500IDXUSD");
    // ~40-ish instruments
    expect(all.length).toBeGreaterThan(35);
  });
});
