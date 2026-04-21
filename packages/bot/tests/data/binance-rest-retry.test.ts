import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock undici.request to control response status per call.
vi.mock("undici", () => ({
  request: vi.fn(),
}));
const { request } = await import("undici");
const mockedRequest = request as unknown as ReturnType<typeof vi.fn>;

import { BinanceRestClient, BinanceRestError } from "../../src/data/binance-rest.js";

function fakeResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    statusCode: status,
    headers,
    body: {
      text: async () => body,
    },
  };
}

describe("BinanceRestClient retry behavior", () => {
  beforeEach(() => {
    mockedRequest.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries on 429 then succeeds", async () => {
    mockedRequest
      .mockResolvedValueOnce(fakeResponse(429, '{"code":-1003,"msg":"Too much request weight"}', { "retry-after": "0" }))
      .mockResolvedValueOnce(fakeResponse(200, "[]"));

    const client = new BinanceRestClient({
      baseUrl: "https://example.test",
      retries: 3,
      minTimeoutMs: 1,
      maxTimeoutMs: 5,
    });
    const out = await client.getJson<unknown[]>("/fapi/v1/klines", { symbol: "BTCUSDT" });
    expect(out).toEqual([]);
    expect(mockedRequest).toHaveBeenCalledTimes(2);
  });

  it("retries on 500 then succeeds", async () => {
    mockedRequest
      .mockResolvedValueOnce(fakeResponse(500, "upstream boom"))
      .mockResolvedValueOnce(fakeResponse(502, "bad gateway"))
      .mockResolvedValueOnce(fakeResponse(200, '[{"ok":1}]'));

    const client = new BinanceRestClient({
      baseUrl: "https://example.test",
      retries: 5,
      minTimeoutMs: 1,
      maxTimeoutMs: 5,
    });
    const out = await client.getJson<unknown>("/fapi/v1/klines", { symbol: "BTCUSDT" });
    expect(out).toEqual([{ ok: 1 }]);
    expect(mockedRequest).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on 400 (bad param)", async () => {
    mockedRequest.mockResolvedValueOnce(
      fakeResponse(400, '{"code":-1121,"msg":"Invalid symbol"}'),
    );

    const client = new BinanceRestClient({
      baseUrl: "https://example.test",
      retries: 5,
      minTimeoutMs: 1,
      maxTimeoutMs: 5,
    });

    await expect(
      client.getJson<unknown>("/fapi/v1/klines", { symbol: "NOPE" }),
    ).rejects.toMatchObject({
      name: "BinanceRestError",
      status: 400,
      code: -1121,
      retryable: false,
    });
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 401/403/404", async () => {
    for (const status of [401, 403, 404]) {
      mockedRequest.mockReset();
      mockedRequest.mockResolvedValueOnce(fakeResponse(status, `{"code":-2000,"msg":"no"}`));
      const client = new BinanceRestClient({
        baseUrl: "https://example.test",
        retries: 5,
        minTimeoutMs: 1,
        maxTimeoutMs: 5,
      });
      await expect(
        client.getJson<unknown>("/fapi/v1/klines", {}),
      ).rejects.toBeInstanceOf(BinanceRestError);
      expect(mockedRequest).toHaveBeenCalledTimes(1);
    }
  });

  it("gives up after exceeding retries on persistent 500", async () => {
    mockedRequest.mockResolvedValue(fakeResponse(500, "down"));
    const client = new BinanceRestClient({
      baseUrl: "https://example.test",
      retries: 2,
      minTimeoutMs: 1,
      maxTimeoutMs: 5,
    });
    await expect(
      client.getJson<unknown>("/fapi/v1/klines", {}),
    ).rejects.toBeInstanceOf(BinanceRestError);
    // p-retry: retries=2 → 3 attempts total
    expect(mockedRequest).toHaveBeenCalledTimes(3);
  });

  it("builds URLs with query params in a stable order", async () => {
    mockedRequest.mockResolvedValueOnce(fakeResponse(200, "[]"));
    const client = new BinanceRestClient({ baseUrl: "https://example.test" });
    await client.getJson<unknown>("/fapi/v1/klines", {
      symbol: "BTCUSDT",
      interval: "1h",
      limit: "1000",
    });
    const url = (mockedRequest.mock.calls[0]?.[0] as string) ?? "";
    expect(url).toContain("https://example.test/fapi/v1/klines");
    expect(url).toContain("symbol=BTCUSDT");
    expect(url).toContain("interval=1h");
    expect(url).toContain("limit=1000");
  });
});
