/**
 * FrictionModel tests — verify the friction values match the published
 * Pepperstone Razor schedule from spec §6, three profiles produce
 * different costs, and the model is deterministic under a fixed seed.
 */

import { describe, expect, it } from "vitest";

import {
  commissionUsd,
  FrictionModel,
  isInNewsWindow,
  mulberry32,
  pipSize,
  sampleSlippagePips,
  sampleSpread,
  swapForNight,
  todMultiplier,
  type LoadedNewsEvent,
} from "../src/friction/index.js";

const EMPTY_NEWS: LoadedNewsEvent[] = [];

const FOMC_EVENT: LoadedNewsEvent[] = [
  {
    timestampMs: Date.parse("2024-12-18T18:00:00Z"),
    category: "FOMC",
  },
];

describe("RNG (mulberry32)", () => {
  it("is deterministic for the same seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 5 }, () => a.next());
    const seqB = Array.from({ length: 5 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("nextNormal stays close to the requested mean over many samples", () => {
    const r = mulberry32(123);
    let sum = 0;
    const N = 50_000;
    for (let i = 0; i < N; i += 1) {
      sum += r.nextNormal(10, 2);
    }
    const mean = sum / N;
    expect(mean).toBeGreaterThan(9.9);
    expect(mean).toBeLessThan(10.1);
  });
});

describe("isInNewsWindow", () => {
  it("matches within +/- 15 min", () => {
    const events: LoadedNewsEvent[] = [
      { timestampMs: Date.parse("2024-12-18T18:00:00Z"), category: "FOMC" },
    ];
    expect(isInNewsWindow(events, Date.parse("2024-12-18T17:55:00Z"))).toBe(true);
    expect(isInNewsWindow(events, Date.parse("2024-12-18T18:15:00Z"))).toBe(true);
    expect(isInNewsWindow(events, Date.parse("2024-12-18T18:16:00Z"))).toBe(false);
    expect(isInNewsWindow(events, Date.parse("2024-12-18T17:44:00Z"))).toBe(false);
  });

  it("returns false on an empty event list", () => {
    expect(isInNewsWindow([], Date.parse("2024-12-18T18:00:00Z"))).toBe(false);
  });
});

describe("todMultiplier (spec §6.3)", () => {
  it("returns the published bands", () => {
    expect(todMultiplier(0)).toBe(1.2);
    expect(todMultiplier(6)).toBe(1.2);
    expect(todMultiplier(7)).toBe(1.1);
    expect(todMultiplier(8)).toBe(1.0);
    expect(todMultiplier(15)).toBe(1.0);
    expect(todMultiplier(16)).toBe(1.0);
    expect(todMultiplier(17)).toBe(1.1);
    expect(todMultiplier(20)).toBe(1.1);
    expect(todMultiplier(21)).toBe(1.5);
    expect(todMultiplier(22)).toBe(2.0);
    expect(todMultiplier(23)).toBe(1.3);
  });
});

describe("pipSize", () => {
  it("returns 0.0001 for non-JPY FX", () => {
    expect(pipSize("EURUSD")).toBe(0.0001);
    expect(pipSize("GBPUSD")).toBe(0.0001);
  });

  it("returns 0.01 for JPY-quoted FX", () => {
    expect(pipSize("USDJPY")).toBe(0.01);
    expect(pipSize("EURJPY")).toBe(0.01);
    expect(pipSize("GBPJPY")).toBe(0.01);
  });

  it("returns 0.01 for metals + oil", () => {
    expect(pipSize("XAUUSD")).toBe(0.01);
    expect(pipSize("XAGUSD")).toBe(0.01);
    expect(pipSize("BRENTCMDUSD")).toBe(0.01);
    expect(pipSize("LIGHTCMDUSD")).toBe(0.01);
  });
});

describe("sampleSpread", () => {
  it("returns 0 under zero_friction profile regardless of seed", () => {
    const rng = mulberry32(1);
    const sample = sampleSpread({
      instrument: "EURUSD",
      profile: "zero_friction",
      atUtc: new Date("2024-06-15T10:00:00Z"),
      isInNewsWindow: false,
      rng,
    });
    expect(sample.pips).toBe(0);
  });

  it("EURUSD non-news mean over many samples falls near 0.15 * tod_mult", () => {
    // 10:00 UTC -> 1.0x band. EURUSD mean 0.15 pips. Expect sample mean ~0.15.
    const rng = mulberry32(7);
    let sum = 0;
    const N = 5000;
    for (let i = 0; i < N; i += 1) {
      sum += sampleSpread({
        instrument: "EURUSD",
        profile: "pepperstone_razor",
        atUtc: new Date("2024-06-15T10:00:00Z"),
        isInNewsWindow: false,
        rng,
      }).pips;
    }
    const mean = sum / N;
    // The min_spread floor (0) and normal sampling around 0.15 +/- 0.10
    // pin the mean to roughly the truncated-normal expectation. Allow
    // generous tolerance for the seed.
    expect(mean).toBeGreaterThan(0.1);
    expect(mean).toBeLessThan(0.25);
  });

  it("news window widens by 5..10x", () => {
    const rng = mulberry32(7);
    const sample = sampleSpread({
      instrument: "EURUSD",
      profile: "pepperstone_razor",
      atUtc: new Date("2024-12-18T18:00:00Z"),
      isInNewsWindow: true,
      rng,
    });
    // With mean 0.15 * news 5..10 = 0.75..1.5 baseline; widely above the
    // non-news mean. Just check it's clearly elevated.
    expect(sample.pips).toBeGreaterThan(0.5);
    expect(sample.newsMult).toBeGreaterThanOrEqual(5);
    expect(sample.newsMult).toBeLessThanOrEqual(10);
  });

  it("pessimistic mean = 1.5x razor mean", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const razor = sampleSpread({
      instrument: "EURUSD",
      profile: "pepperstone_razor",
      atUtc: new Date("2024-06-15T10:00:00Z"),
      isInNewsWindow: false,
      rng: a,
    });
    const pess = sampleSpread({
      instrument: "EURUSD",
      profile: "pessimistic",
      atUtc: new Date("2024-06-15T10:00:00Z"),
      isInNewsWindow: false,
      rng: b,
    });
    // With identical RNG state, pessimistic uses 1.5x mean + 1.5x stddev.
    // The exact relationship depends on the normal sample but the
    // expectation is pess > razor.
    expect(pess.pips).toBeGreaterThan(razor.pips);
  });
});

describe("sampleSlippagePips", () => {
  it("returns 0 under zero_friction", () => {
    const rng = mulberry32(1);
    expect(
      sampleSlippagePips({
        orderType: "market",
        isInNewsWindow: false,
        atr14: 0.001,
        medianAtr14_60d: 0.001,
        rng,
        profile: "zero_friction",
      }),
    ).toBe(0);
  });

  it("normal market order: base = 0.1 + 0.2*normalized_atr (normalized=1)", () => {
    const rng = mulberry32(7);
    const slip = sampleSlippagePips({
      orderType: "market",
      isInNewsWindow: false,
      atr14: 1,
      medianAtr14_60d: 1,
      rng,
      profile: "pepperstone_razor",
    });
    expect(slip).toBeCloseTo(0.3, 8);
  });

  it("stop order: base = 0.3 + 0.5*normalized_atr (normalized=1)", () => {
    const rng = mulberry32(7);
    const slip = sampleSlippagePips({
      orderType: "stop",
      isInNewsWindow: false,
      atr14: 1,
      medianAtr14_60d: 1,
      rng,
      profile: "pepperstone_razor",
    });
    expect(slip).toBeCloseTo(0.8, 8);
  });

  it("clamps normalized_atr to [0.1, 5.0]", () => {
    const rng = mulberry32(7);
    const huge = sampleSlippagePips({
      orderType: "market",
      isInNewsWindow: false,
      atr14: 1000,
      medianAtr14_60d: 1,
      rng,
      profile: "pepperstone_razor",
    });
    expect(huge).toBeCloseTo(0.1 + 0.2 * 5, 8);

    const tiny = sampleSlippagePips({
      orderType: "market",
      isInNewsWindow: false,
      atr14: 0.0001,
      medianAtr14_60d: 1,
      rng,
      profile: "pepperstone_razor",
    });
    expect(tiny).toBeCloseTo(0.1 + 0.2 * 0.1, 8);
  });

  it("news widens to base * (3..13)", () => {
    const rng = mulberry32(7);
    const newsSlip = sampleSlippagePips({
      orderType: "market",
      isInNewsWindow: true,
      atr14: 1,
      medianAtr14_60d: 1,
      rng,
      profile: "pepperstone_razor",
    });
    expect(newsSlip).toBeGreaterThan(0.9); // base 0.3 * (3..13) -> at least 0.9
  });

  it("pessimistic = 2x razor", () => {
    const r1 = mulberry32(7);
    const r2 = mulberry32(7);
    const razor = sampleSlippagePips({
      orderType: "market",
      isInNewsWindow: false,
      atr14: 1,
      medianAtr14_60d: 1,
      rng: r1,
      profile: "pepperstone_razor",
    });
    const pess = sampleSlippagePips({
      orderType: "market",
      isInNewsWindow: false,
      atr14: 1,
      medianAtr14_60d: 1,
      rng: r2,
      profile: "pessimistic",
    });
    expect(pess).toBeCloseTo(razor * 2, 8);
  });
});

describe("commissionUsd (spec §6.7)", () => {
  it("Pepperstone Razor: $7 per round-turn standard lot", () => {
    expect(commissionUsd(1, "pepperstone_razor", "round_turn")).toBeCloseTo(7, 8);
    expect(commissionUsd(0.1, "pepperstone_razor", "round_turn")).toBeCloseTo(0.7, 8);
    expect(commissionUsd(2.5, "pepperstone_razor", "round_turn")).toBeCloseTo(17.5, 8);
  });

  it("Split half on entry, half on exit", () => {
    expect(commissionUsd(1, "pepperstone_razor", "entry")).toBe(3.5);
    expect(commissionUsd(1, "pepperstone_razor", "exit")).toBe(3.5);
  });

  it("zero_friction is 0; pessimistic is 1.2x", () => {
    expect(commissionUsd(1, "zero_friction", "round_turn")).toBe(0);
    expect(commissionUsd(1, "pessimistic", "round_turn")).toBeCloseTo(8.4, 8);
  });
});

describe("swapForNight (spec §6.8)", () => {
  it("returns the table value on non-Wednesday rollovers", () => {
    // Tuesday 22:00 UTC; non-triple. EURUSD long = -$5.50 per lot.
    const rollover = new Date("2024-12-17T22:00:00Z"); // 2024-12-17 is Tuesday
    expect(rollover.getUTCDay()).toBe(2);
    const usd = swapForNight({
      instrument: "EURUSD",
      direction: "long",
      lotSize: 1,
      rolloverUtc: rollover,
      profile: "pepperstone_razor",
    });
    expect(usd).toBe(-5.5);
  });

  it("triples on Wednesday 22:00 UTC", () => {
    const rollover = new Date("2024-12-18T22:00:00Z"); // Wednesday
    expect(rollover.getUTCDay()).toBe(3);
    const usd = swapForNight({
      instrument: "EURUSD",
      direction: "long",
      lotSize: 1,
      rolloverUtc: rollover,
      profile: "pepperstone_razor",
    });
    expect(usd).toBe(-16.5);
  });

  it("pessimistic = 1.5x; zero = 0", () => {
    const rollover = new Date("2024-12-17T22:00:00Z");
    expect(
      swapForNight({
        instrument: "EURUSD",
        direction: "long",
        lotSize: 1,
        rolloverUtc: rollover,
        profile: "pessimistic",
      }),
    ).toBeCloseTo(-8.25, 8);
    expect(
      swapForNight({
        instrument: "EURUSD",
        direction: "long",
        lotSize: 1,
        rolloverUtc: rollover,
        profile: "zero_friction",
      }),
    ).toBe(0);
  });
});

describe("FrictionModel — applyFill / determinism / profiles", () => {
  const baseArgs = {
    instrument: "EURUSD",
    direction: "long" as const,
    orderType: "market" as const,
    rawPrice: 1.085,
    lotSize: 0.1,
    atUtc: new Date("2024-06-15T10:00:00Z"),
    atr14: 0.0006,
    medianAtr14_60d: 0.0006,
    side: "entry" as const,
  };

  it("Pepperstone Razor 0.1-lot EURUSD trade total ~$0.50-2 (spec §9.7)", () => {
    const fm = new FrictionModel({
      profile: "pepperstone_razor",
      randomSeed: 42n,
      newsEvents: EMPTY_NEWS,
    });
    const entry = fm.applyFill(baseArgs);
    const exit = fm.applyFill({ ...baseArgs, side: "exit" });
    const totalUsd =
      entry.breakdown.spread +
      entry.breakdown.slippage +
      entry.breakdown.commission +
      exit.breakdown.spread +
      exit.breakdown.slippage +
      exit.breakdown.commission;
    // Per spec §9.7 verification: ~$0.50-2 total per 0.1 lot.
    expect(totalUsd).toBeGreaterThan(0.4);
    expect(totalUsd).toBeLessThan(3);
  });

  it("identical seed -> identical fills (determinism)", () => {
    const fmA = new FrictionModel({
      profile: "pepperstone_razor",
      randomSeed: 7n,
      newsEvents: EMPTY_NEWS,
    });
    const fmB = new FrictionModel({
      profile: "pepperstone_razor",
      randomSeed: 7n,
      newsEvents: EMPTY_NEWS,
    });
    const a = fmA.applyFill(baseArgs);
    const b = fmB.applyFill(baseArgs);
    expect(a.effectivePrice).toBe(b.effectivePrice);
    expect(a.spreadPips).toBe(b.spreadPips);
    expect(a.slippagePips).toBe(b.slippagePips);
    expect(a.breakdown).toEqual(b.breakdown);
  });

  it("zero_friction profile = exactly zero cost", () => {
    const fm = new FrictionModel({
      profile: "zero_friction",
      randomSeed: 1n,
      newsEvents: EMPTY_NEWS,
    });
    const out = fm.applyFill(baseArgs);
    expect(out.breakdown.spread).toBe(0);
    expect(out.breakdown.slippage).toBe(0);
    expect(out.breakdown.commission).toBe(0);
    expect(out.effectivePrice).toBe(baseArgs.rawPrice);
  });

  it("three profiles produce different total costs on the same trade", () => {
    const seed = 999n;
    const argsBundle = (profile: "pepperstone_razor" | "zero_friction" | "pessimistic") => {
      const fm = new FrictionModel({
        profile,
        randomSeed: seed,
        newsEvents: EMPTY_NEWS,
      });
      const e = fm.applyFill(baseArgs);
      const x = fm.applyFill({ ...baseArgs, side: "exit" });
      return (
        e.breakdown.spread +
        e.breakdown.slippage +
        e.breakdown.commission +
        x.breakdown.spread +
        x.breakdown.slippage +
        x.breakdown.commission
      );
    };
    const razor = argsBundle("pepperstone_razor");
    const zero = argsBundle("zero_friction");
    const pess = argsBundle("pessimistic");
    expect(zero).toBe(0);
    expect(razor).toBeGreaterThan(0);
    expect(pess).toBeGreaterThan(razor);
  });

  it("news window widens spread compared to non-news at the same instant", () => {
    const fmNoNews = new FrictionModel({
      profile: "pepperstone_razor",
      randomSeed: 11n,
      newsEvents: EMPTY_NEWS,
    });
    const fmNews = new FrictionModel({
      profile: "pepperstone_razor",
      randomSeed: 11n,
      newsEvents: FOMC_EVENT,
    });
    const noNewsFill = fmNoNews.applyFill({
      ...baseArgs,
      atUtc: new Date("2024-12-18T18:00:00Z"),
    });
    const newsFill = fmNews.applyFill({
      ...baseArgs,
      atUtc: new Date("2024-12-18T18:00:00Z"),
    });
    expect(newsFill.spreadPips).toBeGreaterThan(noNewsFill.spreadPips);
  });
});
