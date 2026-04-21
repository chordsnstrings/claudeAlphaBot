import { describe, expect, it } from "vitest";

import { parseWsKlineMessage } from "../../src/data/binance-ws.js";

function closedMsg() {
  return {
    stream: "btcusdt@kline_1h",
    data: {
      e: "kline",
      s: "BTCUSDT",
      k: {
        t: 1_700_000_000_000,
        T: 1_700_003_599_999,
        s: "BTCUSDT",
        i: "1h",
        o: "25000",
        c: "25100",
        h: "25200",
        l: "24900",
        v: "321.5",
        x: true,
      },
    },
  };
}

describe("parseWsKlineMessage", () => {
  it("extracts closed candle with numeric fields", () => {
    const c = parseWsKlineMessage(closedMsg());
    expect(c).not.toBeNull();
    expect(c).toEqual({
      symbol: "BTCUSDT",
      openTime: 1_700_000_000_000,
      closeTime: 1_700_003_599_999,
      open: 25000,
      high: 25200,
      low: 24900,
      close: 25100,
      volume: 321.5,
    });
  });

  it("ignores partial (non-closed) kline updates", () => {
    const msg = closedMsg();
    msg.data.k.x = false;
    expect(parseWsKlineMessage(msg)).toBeNull();
  });

  it("ignores subscription response frames", () => {
    expect(parseWsKlineMessage({ result: null, id: 1 })).toBeNull();
  });

  it("ignores malformed payloads gracefully", () => {
    expect(parseWsKlineMessage(null)).toBeNull();
    expect(parseWsKlineMessage(undefined)).toBeNull();
    expect(parseWsKlineMessage("string")).toBeNull();
    expect(parseWsKlineMessage({})).toBeNull();
    expect(parseWsKlineMessage({ data: {} })).toBeNull();
    expect(parseWsKlineMessage({ data: { e: "aggTrade" } })).toBeNull();
  });
});
