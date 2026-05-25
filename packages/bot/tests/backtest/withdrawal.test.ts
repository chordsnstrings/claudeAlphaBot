import { describe, expect, it } from "vitest";

import { runReplay, type StrategyEvaluator } from "../../src/backtest/replay-engine.js";
import { applySkim, utcMonthIndex, utcMonthKey } from "../../src/backtest/withdrawal.js";
import type { Candle, SignalIntent } from "@hydra/shared";

const HOUR = 3_600_000;

function makeCandle(openTime: number, ohlc: Partial<Candle>): Candle {
  return {
    symbol: "BTCUSDT",
    openTime,
    closeTime: openTime + HOUR,
    open: 102,
    high: 102.1,
    low: 101.9,
    close: 102,
    volume: 100,
    ...ohlc,
  };
}

/** Fires LONG once when it sees a candle closing exactly at 100. */
function entryAt100(): StrategyEvaluator {
  return {
    name: "marker",
    evaluate: (symbol, candles, hasOpen) => {
      const last = candles[candles.length - 1];
      if (!last || hasOpen || last.close !== 100) return null;
      const intent: SignalIntent = {
        strategy: "ARB",
        symbol,
        direction: "LONG",
        generatedAt: last.closeTime,
        entryPrice: 100,
        stopPrice: 99, // 1% stop
        tp1Price: 101.5,
        tp2Price: 103,
        tp1AllocationPct: 50,
        breakevenTriggerPrice: 101,
        timeStopUtc: last.openTime + 12 * HOUR,
        reasoning: "marker",
      };
      return intent;
    },
  };
}

describe("applySkim", () => {
  it("none policy never withdraws", () => {
    expect(applySkim(12_345, { kind: "none" })).toEqual({ equity: 12_345, withdrawn: 0 });
  });

  it("skim-to-base pulls everything above base", () => {
    expect(applySkim(11_200, { kind: "skim-to-base", base: 10_000 })).toEqual({
      equity: 10_000,
      withdrawn: 1_200,
    });
  });

  it("skim-to-base never injects capital on a losing balance", () => {
    expect(applySkim(9_400, { kind: "skim-to-base", base: 10_000 })).toEqual({
      equity: 9_400,
      withdrawn: 0,
    });
  });

  it("month helpers bucket consecutive UTC months distinctly", () => {
    const jan = Date.UTC(2024, 0, 31, 23, 0, 0);
    const feb = Date.UTC(2024, 1, 1, 0, 0, 0);
    expect(utcMonthIndex(feb) - utcMonthIndex(jan)).toBe(1);
    expect(utcMonthKey(jan)).toBe("2024-01");
    expect(utcMonthKey(feb)).toBe("2024-02");
  });
});

describe("runReplay — monthly skim integration", () => {
  // A winning trade closes inside January; bars then cross into February.
  function buildSeries(): Candle[] {
    const start = Date.UTC(2024, 0, 29, 0, 0, 0); // Mon Jan 29
    const candles: Candle[] = [];
    candles.push(makeCandle(start, { open: 100, high: 100.1, low: 99.9, close: 100 })); // marker
    candles.push(makeCandle(start + HOUR, { open: 100, high: 101.6, low: 99.95, close: 101 })); // TP1
    candles.push(makeCandle(start + 2 * HOUR, { open: 101, high: 103.2, low: 100.5, close: 103 })); // TP2 → full close
    // Flat bars (close 102, never re-fires) through Feb 1 02:00 UTC.
    const end = Date.UTC(2024, 1, 1, 2, 0, 0);
    for (let t = start + 3 * HOUR; t <= end; t += HOUR) candles.push(makeCandle(t, {}));
    return candles;
  }

  const meta = { BTCUSDT: { symbol: "BTCUSDT" as const, stepSize: 1, minQty: 1 } };

  it("without a policy, profit compounds and nothing is withdrawn", () => {
    const r = runReplay({
      candles: buildSeries(),
      strategies: [entryAt100()],
      opts: { startingEquity: 10_000, symbolMeta: meta },
    });
    expect(r.trades.length).toBe(1);
    expect(r.withdrawals.length).toBe(0);
    expect(r.totalWithdrawn).toBe(0);
    expect(r.finalEquity).toBeGreaterThan(10_000); // win retained
  });

  it("skim-to-base withdraws the month's profit at the Feb boundary", () => {
    const r = runReplay({
      candles: buildSeries(),
      strategies: [entryAt100()],
      opts: {
        startingEquity: 10_000,
        symbolMeta: meta,
        withdrawal: { kind: "skim-to-base", base: 10_000 },
      },
    });
    expect(r.trades.length).toBe(1);
    expect(r.withdrawals.length).toBe(1);
    const w = r.withdrawals[0]!;
    expect(w.monthKey).toBe("2024-01"); // the month that just ended
    expect(w.amountWithdrawn).toBeGreaterThan(0);
    expect(w.equityAfter).toBe(10_000);
    // After the skim, with no further trades, the account sits back at base.
    expect(r.finalEquity).toBe(10_000);
    expect(r.totalWithdrawn).toBeCloseTo(w.amountWithdrawn, 6);
  });
});
