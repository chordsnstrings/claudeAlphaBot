import { describe, expect, it } from "vitest";

import type { DailyCheckEntry, SymbolOutcomeResult } from "../../src/core/drift-monitor.js";
import {
  aggregatePortfolioOutcome,
  classifySymbolOutcome,
} from "../../src/core/drift-monitor.js";
import type { Regime, Symbol as TradingSymbol, SymbolSnapshot } from "@hydra/shared";

const DAY_MS = 86_400_000;
const T0 = Date.UTC(2024, 9, 14, 0, 30, 0);

function snap(p: Partial<SymbolSnapshot> & { symbol: TradingSymbol }): SymbolSnapshot {
  return {
    symbol: p.symbol,
    regime: p.regime ?? "RANGING",
    confidence: p.confidence ?? 0.85,
    bbWidthPercentile: p.bbWidthPercentile ?? 50,
    ema99Slope: p.ema99Slope ?? 0.01,
    atrPct: p.atrPct ?? 1.0,
  };
}

function hist(entries: { dayOffset: number; symbol: TradingSymbol; regime: Regime; outcome: "UNCHANGED" | "DRIFTED" | "FLIPPED" }[]): DailyCheckEntry[] {
  return entries.map((e) => ({
    timestampUtc: T0 + e.dayOffset * DAY_MS,
    symbol: e.symbol,
    currentRegime: e.regime,
    outcome: e.outcome,
  }));
}

describe("classifySymbolOutcome — UNCHANGED", () => {
  it("regime matches and all metrics within thresholds", () => {
    const r = classifySymbolOutcome({
      symbol: "BTCUSDT",
      snapshot: snap({ symbol: "BTCUSDT", regime: "RANGING", confidence: 0.85, bbWidthPercentile: 50, ema99Slope: 0.01 }),
      current: { regime: "RANGING", confidence: 0.80, bbWidthPercentile: 55, ema99Slope: 0.012 },
      dailyHistory: [],
    });
    expect(r.outcome).toBe("UNCHANGED");
  });
});

describe("classifySymbolOutcome — DRIFTED", () => {
  it("matches regime but confidence dropped > 30%", () => {
    const r = classifySymbolOutcome({
      symbol: "BTCUSDT",
      snapshot: snap({ symbol: "BTCUSDT", regime: "RANGING", confidence: 0.85, bbWidthPercentile: 50, ema99Slope: 0.01 }),
      current: { regime: "RANGING", confidence: 0.55, bbWidthPercentile: 50, ema99Slope: 0.01 }, // drop ≈ 35%
      dailyHistory: [],
    });
    expect(r.outcome).toBe("DRIFTED");
    expect(r.confidenceDeltaPct).toBeLessThan(-30);
  });

  it("matches regime but BB width moved > 25 points", () => {
    const r = classifySymbolOutcome({
      symbol: "BTCUSDT",
      snapshot: snap({ symbol: "BTCUSDT", regime: "RANGING", confidence: 0.85, bbWidthPercentile: 50 }),
      current: { regime: "RANGING", confidence: 0.85, bbWidthPercentile: 80, ema99Slope: 0.01 }, // +30pts
      dailyHistory: [],
    });
    expect(r.outcome).toBe("DRIFTED");
  });

  it("regime differs but not 3 days yet", () => {
    const r = classifySymbolOutcome({
      symbol: "BTCUSDT",
      snapshot: snap({ symbol: "BTCUSDT", regime: "RANGING", confidence: 0.85 }),
      current: { regime: "TRENDING_UP", confidence: 0.6, bbWidthPercentile: 55, ema99Slope: 0.05 },
      dailyHistory: hist([
        { dayOffset: -1, symbol: "BTCUSDT", regime: "TRENDING_UP", outcome: "DRIFTED" },
      ]),
    });
    expect(r.outcome).toBe("DRIFTED"); // only 2 consecutive days
  });

  it("EMA99 slope changed sign while regime matches", () => {
    const r = classifySymbolOutcome({
      symbol: "BTCUSDT",
      snapshot: snap({ symbol: "BTCUSDT", regime: "RANGING", ema99Slope: 0.01 }),
      current: { regime: "RANGING", confidence: 0.85, bbWidthPercentile: 50, ema99Slope: -0.01 },
      dailyHistory: [],
    });
    expect(r.outcome).toBe("DRIFTED");
  });
});

describe("classifySymbolOutcome — FLIPPED", () => {
  it("regime differs for 3 consecutive days", () => {
    const r = classifySymbolOutcome({
      symbol: "BTCUSDT",
      snapshot: snap({ symbol: "BTCUSDT", regime: "RANGING" }),
      current: { regime: "TRENDING_UP", confidence: 0.7, bbWidthPercentile: 60, ema99Slope: 0.06 },
      dailyHistory: hist([
        { dayOffset: -2, symbol: "BTCUSDT", regime: "TRENDING_UP", outcome: "DRIFTED" },
        { dayOffset: -1, symbol: "BTCUSDT", regime: "TRENDING_UP", outcome: "DRIFTED" },
      ]),
    });
    expect(r.outcome).toBe("FLIPPED");
  });

  it("RANGING → TRENDING sustained 3 days", () => {
    const r = classifySymbolOutcome({
      symbol: "ETHUSDT",
      snapshot: snap({ symbol: "ETHUSDT", regime: "RANGING" }),
      current: { regime: "TRENDING_DOWN", confidence: 0.8, bbWidthPercentile: 60, ema99Slope: -0.06 },
      dailyHistory: hist([
        { dayOffset: -2, symbol: "ETHUSDT", regime: "TRENDING_DOWN", outcome: "DRIFTED" },
        { dayOffset: -1, symbol: "ETHUSDT", regime: "TRENDING_DOWN", outcome: "DRIFTED" },
      ]),
    });
    expect(r.outcome).toBe("FLIPPED");
  });

  it("non-squeeze → SQUEEZE sustained 2 days", () => {
    const r = classifySymbolOutcome({
      symbol: "SOLUSDT",
      snapshot: snap({ symbol: "SOLUSDT", regime: "RANGING" }),
      current: { regime: "SQUEEZE", confidence: 0.9, bbWidthPercentile: 10, ema99Slope: 0.005 },
      dailyHistory: hist([
        { dayOffset: -1, symbol: "SOLUSDT", regime: "SQUEEZE", outcome: "DRIFTED" },
      ]),
    });
    expect(r.outcome).toBe("FLIPPED");
  });

  it("squeeze entry on day 1 only is not yet FLIPPED", () => {
    const r = classifySymbolOutcome({
      symbol: "SOLUSDT",
      snapshot: snap({ symbol: "SOLUSDT", regime: "RANGING" }),
      current: { regime: "SQUEEZE", confidence: 0.9, bbWidthPercentile: 10, ema99Slope: 0.005 },
      dailyHistory: [],
    });
    expect(r.outcome).toBe("DRIFTED");
  });

  it("ignores entries from other symbols when counting consecutive days", () => {
    const r = classifySymbolOutcome({
      symbol: "BTCUSDT",
      snapshot: snap({ symbol: "BTCUSDT", regime: "RANGING" }),
      current: { regime: "TRENDING_UP", confidence: 0.7, bbWidthPercentile: 60, ema99Slope: 0.06 },
      dailyHistory: hist([
        { dayOffset: -2, symbol: "ETHUSDT", regime: "TRENDING_UP", outcome: "DRIFTED" }, // wrong symbol
        { dayOffset: -1, symbol: "ETHUSDT", regime: "TRENDING_UP", outcome: "DRIFTED" },
      ]),
    });
    // BTC has only 1 day of TRENDING_UP today → DRIFTED, not FLIPPED
    expect(r.outcome).toBe("DRIFTED");
  });
});

function outcome(p: { symbol: TradingSymbol; outcome: "UNCHANGED" | "DRIFTED" | "FLIPPED"; regime?: Regime }): SymbolOutcomeResult {
  return {
    symbol: p.symbol,
    outcome: p.outcome,
    currentRegime: p.regime ?? "RANGING",
    validationRegime: "RANGING",
    confidenceCurrent: 0.85,
    confidenceAtValidation: 0.85,
    confidenceDeltaPct: 0,
    bbWidthCurrent: 50,
    bbWidthAtValidation: 50,
    bbWidthDeltaPoints: 0,
    ema99SlopeCurrent: 0.01,
    ema99SlopeAtValidation: 0.01,
    consecutiveDaysSameOutcome: 1,
    reason: "test",
  };
}

describe("aggregatePortfolioOutcome", () => {
  it("PORTFOLIO_UNCHANGED when all UNCHANGED", () => {
    const r = aggregatePortfolioOutcome({
      symbolOutcomes: [
        outcome({ symbol: "BTCUSDT", outcome: "UNCHANGED" }),
        outcome({ symbol: "ETHUSDT", outcome: "UNCHANGED" }),
        outcome({ symbol: "SOLUSDT", outcome: "UNCHANGED" }),
      ],
      dailyHistory: [],
    });
    expect(r.outcome).toBe("PORTFOLIO_UNCHANGED");
  });

  it("PORTFOLIO_DRIFTED when at least one DRIFTED, none FLIPPED", () => {
    const r = aggregatePortfolioOutcome({
      symbolOutcomes: [
        outcome({ symbol: "BTCUSDT", outcome: "UNCHANGED" }),
        outcome({ symbol: "ETHUSDT", outcome: "DRIFTED" }),
        outcome({ symbol: "SOLUSDT", outcome: "UNCHANGED" }),
      ],
      dailyHistory: [],
    });
    expect(r.outcome).toBe("PORTFOLIO_DRIFTED");
  });

  it("PORTFOLIO_FLIPPED when 2+ symbols FLIPPED today", () => {
    const r = aggregatePortfolioOutcome({
      symbolOutcomes: [
        outcome({ symbol: "BTCUSDT", outcome: "FLIPPED" }),
        outcome({ symbol: "ETHUSDT", outcome: "FLIPPED" }),
        outcome({ symbol: "SOLUSDT", outcome: "UNCHANGED" }),
      ],
      dailyHistory: [],
    });
    expect(r.outcome).toBe("PORTFOLIO_FLIPPED");
    expect(r.flippedSymbols).toContain("BTCUSDT");
    expect(r.flippedSymbols).toContain("ETHUSDT");
  });

  it("PORTFOLIO_FLIPPED when 1 symbol FLIPPED 2 consecutive days", () => {
    const r = aggregatePortfolioOutcome({
      symbolOutcomes: [
        outcome({ symbol: "BTCUSDT", outcome: "FLIPPED" }),
        outcome({ symbol: "ETHUSDT", outcome: "UNCHANGED" }),
        outcome({ symbol: "SOLUSDT", outcome: "UNCHANGED" }),
      ],
      dailyHistory: hist([
        { dayOffset: -1, symbol: "BTCUSDT", regime: "TRENDING_UP", outcome: "FLIPPED" },
      ]),
    });
    expect(r.outcome).toBe("PORTFOLIO_FLIPPED");
  });

  it("PORTFOLIO_DRIFTED when 1 symbol FLIPPED today only (no prior flip)", () => {
    const r = aggregatePortfolioOutcome({
      symbolOutcomes: [
        outcome({ symbol: "BTCUSDT", outcome: "FLIPPED" }),
        outcome({ symbol: "ETHUSDT", outcome: "UNCHANGED" }),
        outcome({ symbol: "SOLUSDT", outcome: "UNCHANGED" }),
      ],
      dailyHistory: [],
    });
    expect(r.outcome).toBe("PORTFOLIO_DRIFTED");
  });

  it("affectedSymbolsForPause = today's FLIPPED symbols only", () => {
    const r = aggregatePortfolioOutcome({
      symbolOutcomes: [
        outcome({ symbol: "BTCUSDT", outcome: "FLIPPED" }),
        outcome({ symbol: "ETHUSDT", outcome: "DRIFTED" }),
        outcome({ symbol: "SOLUSDT", outcome: "UNCHANGED" }),
      ],
      dailyHistory: [],
    });
    expect(r.affectedSymbolsForPause).toEqual(["BTCUSDT"]);
  });
});
