import { describe, expect, it } from "vitest";

import {
  TickToBarBuilder,
  periodMs,
  periodStart,
  type Tick,
} from "../src/ctrader/tick-to-bar.js";

function tick(instrument: string, isoTs: string, price: number, volume = 1): Tick {
  return { instrument, price, volume, timestampUtc: new Date(isoTs) };
}

describe("periodStart / periodMs", () => {
  it("aligns m1 to minute boundary", () => {
    expect(periodMs("m1")).toBe(60_000);
    expect(periodStart(new Date("2025-06-15T12:34:56Z"), "m1").toISOString()).toBe(
      "2025-06-15T12:34:00.000Z",
    );
  });
  it("aligns h1 to hour boundary", () => {
    expect(periodStart(new Date("2025-06-15T12:34:56Z"), "h1").toISOString()).toBe(
      "2025-06-15T12:00:00.000Z",
    );
  });
  it("aligns d1 to UTC midnight", () => {
    expect(periodStart(new Date("2025-06-15T12:34:56Z"), "d1").toISOString()).toBe(
      "2025-06-15T00:00:00.000Z",
    );
  });
});

describe("TickToBarBuilder", () => {
  it("first tick starts a bar but emits nothing", () => {
    const b = new TickToBarBuilder();
    expect(b.onTick(tick("EURUSD", "2025-06-15T12:00:30Z", 1.1), "m1")).toBeNull();
  });

  it("folds same-period ticks into open/high/low/close/volume", () => {
    const b = new TickToBarBuilder();
    b.onTick(tick("EURUSD", "2025-06-15T12:00:00Z", 1.1, 1), "m1");
    b.onTick(tick("EURUSD", "2025-06-15T12:00:15Z", 1.102, 1), "m1");
    b.onTick(tick("EURUSD", "2025-06-15T12:00:30Z", 1.099, 1), "m1");
    b.onTick(tick("EURUSD", "2025-06-15T12:00:45Z", 1.101, 1), "m1");
    const peek = b.peek("EURUSD", "m1");
    expect(peek).not.toBeNull();
    expect(peek?.open).toBe(1.1);
    expect(peek?.high).toBe(1.102);
    expect(peek?.low).toBe(1.099);
    expect(peek?.close).toBe(1.101);
    expect(peek?.volume).toBe(4);
  });

  it("emits a finalized bar when the period rolls", () => {
    const b = new TickToBarBuilder();
    b.onTick(tick("EURUSD", "2025-06-15T12:00:00Z", 1.1), "m1");
    b.onTick(tick("EURUSD", "2025-06-15T12:00:30Z", 1.101), "m1");
    const finalized = b.onTick(tick("EURUSD", "2025-06-15T12:01:00Z", 1.099), "m1");
    expect(finalized).not.toBeNull();
    expect(finalized?.timestampUtc.toISOString()).toBe("2025-06-15T12:00:00.000Z");
    expect(finalized?.close).toBe(1.101);
    expect(finalized?.source).toBe("live");
  });

  it("keeps independent state per (instrument, timeframe)", () => {
    const b = new TickToBarBuilder();
    b.onTick(tick("EURUSD", "2025-06-15T12:00:00Z", 1.1), "m1");
    b.onTick(tick("GBPUSD", "2025-06-15T12:00:00Z", 1.27), "m1");
    const eur = b.onTick(tick("EURUSD", "2025-06-15T12:01:00Z", 1.101), "m1");
    expect(eur?.instrument).toBe("EURUSD");
    expect(b.peek("GBPUSD", "m1")?.close).toBe(1.27);
  });

  it("flushAll finalises all in-flight bars", () => {
    const b = new TickToBarBuilder();
    b.onTick(tick("EURUSD", "2025-06-15T12:00:00Z", 1.1), "m1");
    b.onTick(tick("GBPUSD", "2025-06-15T12:00:00Z", 1.27), "m1");
    const flushed = b.flushAll();
    expect(flushed).toHaveLength(2);
    expect(b.peek("EURUSD", "m1")).toBeNull();
  });
});
