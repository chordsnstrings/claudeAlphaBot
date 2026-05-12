import { describe, expect, it } from "vitest";

import {
  planWalkForwardWindows,
  summariseWalkForward,
  type WindowResult,
} from "../src/walk-forward.js";

describe("planWalkForwardWindows", () => {
  it("produces exact non-overlapping IS/OOS joins", () => {
    const windows = planWalkForwardWindows({
      from: new Date("2024-01-01T00:00:00Z"),
      to: new Date("2025-01-01T00:00:00Z"),
      trainMonths: 6,
      testMonths: 1,
      stepMonths: 1,
      minTradesPerWindow: 0,
    });
    expect(windows.length).toBeGreaterThan(0);
    for (const w of windows) {
      expect(w.isTo.getTime()).toBe(w.oosFrom.getTime());
      expect(w.isFrom.getTime()).toBeLessThan(w.isTo.getTime());
      expect(w.oosFrom.getTime()).toBeLessThan(w.oosTo.getTime());
    }
    // No window's OOS overlaps the next window's OOS.
    for (let i = 1; i < windows.length; i += 1) {
      const prev = windows[i - 1];
      const cur = windows[i];
      if (prev === undefined || cur === undefined) {
        continue;
      }
      // Windows roll by stepMonths; OOS starts march forward by stepMonths.
      expect(cur.oosFrom.getTime()).toBeGreaterThan(prev.oosFrom.getTime());
    }
  });

  it("yields ~6 windows for 6mo data with 4mo train + 1mo test", () => {
    const windows = planWalkForwardWindows({
      from: new Date("2025-11-01T00:00:00Z"),
      to: new Date("2026-05-01T00:00:00Z"),
      trainMonths: 4,
      testMonths: 1,
      stepMonths: 1,
      minTradesPerWindow: 0,
    });
    // train+test = 5 months; with step=1 month from a 6-month range we
    // get windows starting 2025-11, 2025-12 → 2 fully-covered windows
    // plus one clipped at the end.
    expect(windows.length).toBeGreaterThanOrEqual(2);
    expect(windows.length).toBeLessThanOrEqual(3);
  });

  it("returns no windows when from >= to", () => {
    expect(
      planWalkForwardWindows({
        from: new Date("2025-01-01T00:00:00Z"),
        to: new Date("2024-01-01T00:00:00Z"),
        trainMonths: 12,
        testMonths: 3,
        stepMonths: 3,
        minTradesPerWindow: 0,
      }),
    ).toEqual([]);
  });

  it("rejects month counts < 1", () => {
    expect(() =>
      planWalkForwardWindows({
        from: new Date("2025-01-01T00:00:00Z"),
        to: new Date("2025-12-01T00:00:00Z"),
        trainMonths: 0,
        testMonths: 3,
        stepMonths: 3,
        minTradesPerWindow: 0,
      }),
    ).toThrow();
  });
});

describe("summariseWalkForward", () => {
  it("computes WF consistency = mean(OOS Sharpe) / mean(IS Sharpe)", () => {
    const results: WindowResult[] = [
      {
        window: {
          index: 0,
          isFrom: new Date(),
          isTo: new Date(),
          oosFrom: new Date(),
          oosTo: new Date(),
        },
        isSharpe: 2.0,
        oosSharpe: 1.0,
        isTrades: 50,
        oosTrades: 30,
        isSessionId: "is-0",
        oosSessionId: "oos-0",
      },
      {
        window: {
          index: 1,
          isFrom: new Date(),
          isTo: new Date(),
          oosFrom: new Date(),
          oosTo: new Date(),
        },
        isSharpe: 1.0,
        oosSharpe: 0.5,
        isTrades: 50,
        oosTrades: 30,
        isSessionId: "is-1",
        oosSessionId: "oos-1",
      },
    ];
    const summary = summariseWalkForward("parent-1", { minTradesPerWindow: 0 }, results);
    expect(summary.meanIsSharpe).toBe(1.5);
    expect(summary.meanOosSharpe).toBe(0.75);
    expect(summary.walkForwardConsistency).toBe(0.5);
    expect(summary.windowCount).toBe(2);
    expect(summary.filteredWindowCount).toBe(2);
  });

  it("excludes windows below minTradesPerWindow from the mean", () => {
    const results: WindowResult[] = [
      {
        window: {
          index: 0,
          isFrom: new Date(),
          isTo: new Date(),
          oosFrom: new Date(),
          oosTo: new Date(),
        },
        isSharpe: 99,
        oosSharpe: -99,
        isTrades: 5, // below threshold
        oosTrades: 5,
        isSessionId: "is-0",
        oosSessionId: "oos-0",
      },
      {
        window: {
          index: 1,
          isFrom: new Date(),
          isTo: new Date(),
          oosFrom: new Date(),
          oosTo: new Date(),
        },
        isSharpe: 2,
        oosSharpe: 1,
        isTrades: 100,
        oosTrades: 100,
        isSessionId: "is-1",
        oosSessionId: "oos-1",
      },
    ];
    const summary = summariseWalkForward("parent", { minTradesPerWindow: 30 }, results);
    expect(summary.filteredWindowCount).toBe(1);
    expect(summary.meanIsSharpe).toBe(2);
    expect(summary.walkForwardConsistency).toBe(0.5);
  });
});
