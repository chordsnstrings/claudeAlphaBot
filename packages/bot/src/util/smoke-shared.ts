/**
 * Import-smoke file: if this compiles, `@hydra/shared` is properly wired.
 * Deleted or expanded in later phases.
 */
import {
  DIRECTIONS,
  MODES,
  REGIMES,
  STRATEGIES,
  SYMBOLS,
  type Candle,
  type SignalIntent,
  type Trade,
  type Direction,
  type Regime,
  type StrategyName,
  type Symbol as TradingSymbol,
} from "@hydra/shared";

export function enumerate(): {
  symbols: readonly TradingSymbol[];
  strategies: readonly StrategyName[];
  directions: readonly Direction[];
  modes: readonly string[];
  regimes: readonly Regime[];
} {
  return {
    symbols: SYMBOLS,
    strategies: STRATEGIES,
    directions: DIRECTIONS,
    modes: MODES,
    regimes: REGIMES,
  };
}

export function makeDummyIntent(c: Candle): SignalIntent {
  return {
    strategy: "ARB",
    symbol: c.symbol,
    direction: "LONG",
    generatedAt: c.closeTime,
    entryPrice: c.close,
    stopPrice: c.close * 0.99,
    tp1Price: c.close * 1.015,
    tp2Price: c.close * 1.03,
    tp1AllocationPct: 50,
    breakevenTriggerPrice: c.close * 1.01,
    timeStopUtc: c.closeTime + 12 * 60 * 60 * 1000,
    reasoning: "smoke-test",
  };
}

export type _Ensure = Trade;
