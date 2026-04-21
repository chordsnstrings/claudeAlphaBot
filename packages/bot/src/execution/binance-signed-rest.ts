/**
 * Binance Futures authenticated REST client — thin wrapper around the
 * public `BinanceRestClient.getJson` shape, adding HMAC SHA-256 signing
 * and the private endpoints we need:
 *   - POST /fapi/v1/order
 *   - DELETE /fapi/v1/order
 *   - GET  /fapi/v2/positionRisk
 *   - GET  /fapi/v2/account
 *   - GET  /fapi/v1/openOrders
 *
 * We keep it minimal: no leverage/margin-type toggles (operator sets once
 * via the Binance UI per spec §8 operational setup), no user-data
 * streams (fills are confirmed by polling positionRisk on startup for
 * reconciliation — intra-session we trust the REST response).
 *
 * Signing: `queryString + timestamp=<ms>&recvWindow=5000`, then
 * HMAC-SHA256(apiSecret) appended as `&signature=<hex>`.
 */
import { createHmac } from "node:crypto";
import { request } from "undici";

import type { Direction, Symbol as TradingSymbol } from "@hydra/shared";

const PROD_REST = "https://fapi.binance.com";
const TESTNET_REST = "https://testnet.binancefuture.com";

export interface BinanceSignedOptions {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly testnet?: boolean;
  readonly baseUrl?: string;
  readonly recvWindowMs?: number;
  readonly requestTimeoutMs?: number;
}

export interface PlaceMarketEntryParams {
  readonly symbol: TradingSymbol;
  readonly direction: Direction;
  readonly quantity: number;
}

export interface PlaceStopMarketParams {
  readonly symbol: TradingSymbol;
  /** The side of the CLOSING order — opposite of the position's direction. */
  readonly closeSide: "BUY" | "SELL";
  readonly stopPrice: number;
  readonly quantity: number;
}

export interface PlaceTakeProfitMarketParams {
  readonly symbol: TradingSymbol;
  readonly closeSide: "BUY" | "SELL";
  readonly stopPrice: number; // trigger
  readonly quantity: number;
}

export interface OrderResponse {
  readonly orderId: number;
  readonly symbol: string;
  readonly status: string;
  readonly clientOrderId: string;
  readonly price: string;
  readonly avgPrice?: string;
  readonly origQty: string;
  readonly executedQty: string;
  readonly type: string;
  readonly side: string;
  readonly reduceOnly?: boolean;
  readonly closePosition?: boolean;
  readonly stopPrice?: string;
  readonly updateTime?: number;
}

export interface PositionRiskRow {
  readonly symbol: string;
  readonly positionAmt: string;
  readonly entryPrice: string;
  readonly markPrice: string;
  readonly unRealizedProfit: string;
  readonly leverage: string;
}

export class BinanceSignedRestError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  constructor(message: string, status: number, code?: number) {
    super(message);
    this.name = "BinanceSignedRestError";
    this.status = status;
    this.code = code;
  }
}

export class BinanceSignedRest {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly recvWindow: number;
  private readonly requestTimeoutMs: number;

  constructor(opts: BinanceSignedOptions) {
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    this.baseUrl = opts.baseUrl ?? (opts.testnet ? TESTNET_REST : PROD_REST);
    this.recvWindow = opts.recvWindowMs ?? 5000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
  }

  /** Market entry, non-reduce-only. Returns the exchange order record. */
  async placeMarketEntry(p: PlaceMarketEntryParams): Promise<OrderResponse> {
    return this.signedRequest<OrderResponse>("POST", "/fapi/v1/order", {
      symbol: p.symbol,
      side: p.direction === "LONG" ? "BUY" : "SELL",
      type: "MARKET",
      quantity: formatQty(p.quantity),
    });
  }

  /** STOP_MARKET reduce-only bracket. Used for the protective stop. */
  async placeStopMarket(p: PlaceStopMarketParams): Promise<OrderResponse> {
    return this.signedRequest<OrderResponse>("POST", "/fapi/v1/order", {
      symbol: p.symbol,
      side: p.closeSide,
      type: "STOP_MARKET",
      stopPrice: formatPrice(p.stopPrice),
      quantity: formatQty(p.quantity),
      reduceOnly: "true",
      workingType: "MARK_PRICE",
    });
  }

  /** TAKE_PROFIT_MARKET reduce-only bracket. */
  async placeTakeProfitMarket(p: PlaceTakeProfitMarketParams): Promise<OrderResponse> {
    return this.signedRequest<OrderResponse>("POST", "/fapi/v1/order", {
      symbol: p.symbol,
      side: p.closeSide,
      type: "TAKE_PROFIT_MARKET",
      stopPrice: formatPrice(p.stopPrice),
      quantity: formatQty(p.quantity),
      reduceOnly: "true",
      workingType: "MARK_PRICE",
    });
  }

  async cancelOrder(symbol: TradingSymbol, orderId: string): Promise<OrderResponse> {
    return this.signedRequest<OrderResponse>("DELETE", "/fapi/v1/order", {
      symbol,
      orderId,
    });
  }

  async getPositionRisk(): Promise<readonly PositionRiskRow[]> {
    return this.signedRequest<readonly PositionRiskRow[]>(
      "GET",
      "/fapi/v2/positionRisk",
      {},
    );
  }

  async getOpenOrders(symbol?: TradingSymbol): Promise<readonly OrderResponse[]> {
    const params: Record<string, string> = {};
    if (symbol) params["symbol"] = symbol;
    return this.signedRequest<readonly OrderResponse[]>("GET", "/fapi/v1/openOrders", params);
  }

  private async signedRequest<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string | number>,
  ): Promise<T> {
    const ts = Date.now();
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) merged[k] = String(v);
    merged["timestamp"] = String(ts);
    merged["recvWindow"] = String(this.recvWindow);
    const qs = toQueryString(merged);
    const signature = createHmac("sha256", this.apiSecret).update(qs).digest("hex");
    const full = `${qs}&signature=${signature}`;

    let url: string;
    let body: string | undefined;
    if (method === "GET" || method === "DELETE") {
      url = `${this.baseUrl}${path}?${full}`;
      body = undefined;
    } else {
      url = `${this.baseUrl}${path}`;
      body = full;
    }

    const headers: Record<string, string> = {
      "X-MBX-APIKEY": this.apiKey,
      "user-agent": "hydra-bot/0.1",
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";

    const res = await request(url, {
      method,
      headersTimeout: this.requestTimeoutMs,
      bodyTimeout: this.requestTimeoutMs,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const status = res.statusCode;
    const text = await res.body.text();
    if (status >= 200 && status < 300) {
      return JSON.parse(text) as T;
    }
    let code: number | undefined;
    let msg = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { code?: number; msg?: string };
      if (typeof parsed.code === "number") code = parsed.code;
      if (typeof parsed.msg === "string") msg = parsed.msg;
    } catch {
      /* leave raw */
    }
    throw new BinanceSignedRestError(`Binance ${status} on ${path}: ${msg}`, status, code);
  }
}

function toQueryString(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function formatPrice(p: number): string {
  // Binance accepts up to 8 decimals; trim scientific notation.
  return p.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function formatQty(q: number): string {
  return q.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}
