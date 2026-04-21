/**
 * Binance Futures REST client.
 *
 * Scope: only the two public endpoints we need for historical data:
 *   - GET /fapi/v1/klines
 *   - GET /fapi/v1/fundingRate
 *
 * Design:
 *   - undici `request()` for native fetch with connection pooling
 *   - p-retry for 429 / 5xx / network errors with exponential backoff
 *   - Never retries 4xx client errors (400, 401, 403, 404) — that's a
 *     bug in our code, not a transient failure
 *   - Honors `Retry-After` header on 429 if present
 *   - Testnet base URL is selected via `BINANCE_TESTNET=true`
 *
 * Rate limits (spec + phase-4 rubric):
 *   - 2400 request-weight per minute on futures
 *   - klines: weight 1–10 depending on limit; fundingRate: weight 1
 *   - Historical loader paces itself at 100ms between calls; at 600
 *     calls/min worst case that's ~6000 weight, well under 2400 only
 *     if weight-per-call stays ≤ 4, so we keep `limit=1000` (weight 5)
 *     with a larger pace. Historical-loader uses 300ms minimum.
 */
import { request } from "undici";
import pRetry, { AbortError } from "p-retry";

import type { Symbol as TradingSymbol } from "@hydra/shared";

const PROD_REST = "https://fapi.binance.com";
const TESTNET_REST = "https://testnet.binancefuture.com";

export interface BinanceRestClientOptions {
  readonly testnet?: boolean;
  readonly baseUrl?: string;
  readonly retries?: number;
  readonly minTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

export interface KlineParams {
  readonly symbol: TradingSymbol;
  readonly interval: "1h";
  readonly startTime?: number;
  readonly endTime?: number;
  readonly limit?: number;
}

export interface FundingRateParams {
  readonly symbol: TradingSymbol;
  readonly startTime?: number;
  readonly endTime?: number;
  readonly limit?: number;
}

/**
 * Raw kline row from Binance. Tuple indices:
 * 0: open_time, 1: open, 2: high, 3: low, 4: close, 5: volume,
 * 6: close_time, 7: quote_asset_volume, 8: trades,
 * 9: taker_buy_base, 10: taker_buy_quote, 11: ignore.
 */
export type RawKline = readonly [
  number, string, string, string, string, string,
  number, string, number, string, string, string,
];

export interface ParsedKline {
  readonly symbol: TradingSymbol;
  readonly openTime: number;
  readonly closeTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface RawFundingRate {
  readonly symbol: string;
  readonly fundingTime: number;
  readonly fundingRate: string;
}

export interface ParsedFundingRate {
  readonly symbol: TradingSymbol;
  readonly fundingTime: number;
  readonly fundingRate: number;
}

export class BinanceRestError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean, code?: number) {
    super(message);
    this.name = "BinanceRestError";
    this.status = status;
    this.retryable = retryable;
    if (code !== undefined) this.code = code;
  }
}

export class BinanceRestClient {
  private readonly baseUrl: string;
  private readonly retries: number;
  private readonly minTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(opts: BinanceRestClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? (opts.testnet ? TESTNET_REST : PROD_REST);
    this.retries = opts.retries ?? 5;
    this.minTimeoutMs = opts.minTimeoutMs ?? 500;
    this.maxTimeoutMs = opts.maxTimeoutMs ?? 30_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
  }

  async getKlines(params: KlineParams): Promise<readonly ParsedKline[]> {
    const qs: Record<string, string> = {
      symbol: params.symbol,
      interval: params.interval,
      limit: String(params.limit ?? 1000),
    };
    if (params.startTime !== undefined) qs["startTime"] = String(params.startTime);
    if (params.endTime !== undefined) qs["endTime"] = String(params.endTime);

    const raw = await this.getJson<readonly RawKline[]>("/fapi/v1/klines", qs);
    return raw.map((r) => parseKline(params.symbol, r));
  }

  async getFundingRateHistory(params: FundingRateParams): Promise<readonly ParsedFundingRate[]> {
    const qs: Record<string, string> = {
      symbol: params.symbol,
      limit: String(params.limit ?? 1000),
    };
    if (params.startTime !== undefined) qs["startTime"] = String(params.startTime);
    if (params.endTime !== undefined) qs["endTime"] = String(params.endTime);

    const raw = await this.getJson<readonly RawFundingRate[]>("/fapi/v1/fundingRate", qs);
    return raw.map((r) => parseFundingRate(params.symbol, r));
  }

  /**
   * Issue a GET request, parsing JSON, with retry semantics.
   * Exposed for tests that want to swap the fetcher.
   */
  async getJson<T>(path: string, query: Record<string, string>): Promise<T> {
    const url = buildUrl(this.baseUrl, path, query);

    return pRetry(
      async () => {
        const res = await request(url, {
          method: "GET",
          headersTimeout: this.requestTimeoutMs,
          bodyTimeout: this.requestTimeoutMs,
          headers: { accept: "application/json", "user-agent": "hydra-bot/0.1" },
        });
        const status = res.statusCode;
        const body = await res.body.text();

        if (status >= 200 && status < 300) {
          try {
            return JSON.parse(body) as T;
          } catch (err) {
            // Malformed JSON from a 2xx is a bug on their end; not our
            // fault to retry beyond p-retry's default handling.
            throw new BinanceRestError(
              `Malformed JSON response: ${(err as Error).message}`,
              status,
              true,
            );
          }
        }

        // Parse Binance error envelope if possible
        let apiCode: number | undefined;
        let apiMsg = body.slice(0, 300);
        try {
          const parsed = JSON.parse(body) as { code?: number; msg?: string };
          if (typeof parsed.code === "number") apiCode = parsed.code;
          if (typeof parsed.msg === "string") apiMsg = parsed.msg;
        } catch {
          // body wasn't JSON — that's fine, keep raw snippet
        }

        const retryable = status === 429 || status === 418 || (status >= 500 && status < 600);
        const restErr = new BinanceRestError(
          `Binance ${status} on ${path}: ${apiMsg}`,
          status,
          retryable,
          apiCode,
        );

        if (!retryable) {
          // AbortError tells p-retry to stop immediately — we don't
          // want to hammer Binance on a 400/401/404.
          throw new AbortError(restErr);
        }

        // Honor Retry-After on 429 if provided (seconds or HTTP date)
        if (status === 429) {
          const hdr = res.headers["retry-after"];
          const secs = parseRetryAfter(typeof hdr === "string" ? hdr : undefined);
          if (secs !== null) {
            await new Promise((r) => setTimeout(r, secs * 1000));
          }
        }

        throw restErr;
      },
      {
        retries: this.retries,
        factor: 2,
        minTimeout: this.minTimeoutMs,
        maxTimeout: this.maxTimeoutMs,
        randomize: true,
      },
    );
  }
}

function buildUrl(base: string, path: string, query: Record<string, string>): string {
  const u = new URL(path, base);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

function parseRetryAfter(header: string | undefined): number | null {
  if (!header) return null;
  const n = Number(header);
  if (Number.isFinite(n) && n >= 0) return n;
  const dt = Date.parse(header);
  if (Number.isFinite(dt)) {
    const secs = Math.max(0, Math.ceil((dt - Date.now()) / 1000));
    return secs;
  }
  return null;
}

export function parseKline(symbol: TradingSymbol, raw: RawKline): ParsedKline {
  const [openTime, open, high, low, close, volume, closeTime] = raw;
  return {
    symbol,
    openTime,
    closeTime,
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
  };
}

export function parseFundingRate(
  symbol: TradingSymbol,
  raw: RawFundingRate,
): ParsedFundingRate {
  return {
    symbol,
    fundingTime: raw.fundingTime,
    fundingRate: Number(raw.fundingRate),
  };
}

/**
 * Build a client from environment. Only reads BINANCE_TESTNET.
 */
export function binanceRestFromEnv(env: NodeJS.ProcessEnv = process.env): BinanceRestClient {
  const testnet = env["BINANCE_TESTNET"] === "true";
  return new BinanceRestClient({ testnet });
}
