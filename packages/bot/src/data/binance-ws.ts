/**
 * Binance Futures WebSocket subscriber for 1h klines.
 *
 * Binance publishes one continuous stream per symbol at
 *   wss://fstream.binance.com/stream?streams=<lc-symbol>@kline_1h
 * Testnet host: wss://stream.binancefuture.com/stream
 *
 * We only care about CLOSED candles (`k.x === true`). Partial updates
 * are ignored — strategies decide on hourly boundaries per spec §8.
 *
 * Reconnect policy:
 *   - Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s cap
 *   - Resets on successful message
 *   - Binance sends ping frames; `ws` library auto-pongs. We also
 *     listen for a stall of 60s and force-reconnect.
 */
import { EventEmitter } from "node:events";

import WebSocket from "ws";

import type { Symbol as TradingSymbol } from "@hydra/shared";
import type { Candle } from "@hydra/shared";

const PROD_WS = "wss://fstream.binance.com";
const TESTNET_WS = "wss://stream.binancefuture.com";

export interface BinanceWsOptions {
  readonly symbols: readonly TradingSymbol[];
  readonly testnet?: boolean;
  readonly baseUrl?: string;
  readonly stallTimeoutMs?: number;
  readonly backoffMinMs?: number;
  readonly backoffMaxMs?: number;
}

export interface BinanceWsEvents {
  candle: (candle: Candle) => void;
  open: () => void;
  close: (code: number, reason: string) => void;
  error: (err: Error) => void;
  reconnect: (attempt: number, delayMs: number) => void;
}

interface CombinedStreamMessage {
  readonly stream: string;
  readonly data: {
    readonly e: string;
    readonly s: string;
    readonly k: {
      readonly t: number;
      readonly T: number;
      readonly s: string;
      readonly i: string;
      readonly o: string;
      readonly c: string;
      readonly h: string;
      readonly l: string;
      readonly v: string;
      readonly x: boolean;
    };
  };
}

export class BinanceWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly stallTimeoutMs: number;
  private readonly backoffMinMs: number;
  private readonly backoffMaxMs: number;
  private attempt = 0;
  private stallTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(opts: BinanceWsOptions) {
    super();
    if (opts.symbols.length === 0) {
      throw new Error("BinanceWsClient requires at least one symbol");
    }
    const base = opts.baseUrl ?? (opts.testnet ? TESTNET_WS : PROD_WS);
    const streams = opts.symbols.map((s) => `${s.toLowerCase()}@kline_1h`).join("/");
    this.url = `${base}/stream?streams=${streams}`;
    this.stallTimeoutMs = opts.stallTimeoutMs ?? 60_000;
    this.backoffMinMs = opts.backoffMinMs ?? 1_000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000;
  }

  override on<E extends keyof BinanceWsEvents>(event: E, listener: BinanceWsEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override emit<E extends keyof BinanceWsEvents>(event: E, ...args: Parameters<BinanceWsEvents[E]>): boolean {
    return super.emit(event, ...args);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearStallTimer();
    if (this.ws) {
      await new Promise<void>((resolve) => {
        const ws = this.ws!;
        const done = (): void => resolve();
        ws.once("close", done);
        try {
          ws.close(1000, "shutdown");
        } catch {
          done();
        }
      });
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on("open", () => {
      this.attempt = 0;
      this.resetStallTimer();
      this.emit("open");
    });

    ws.on("message", (data: WebSocket.RawData) => {
      this.resetStallTimer();
      try {
        const raw = rawDataToString(data);
        const msg = JSON.parse(raw) as CombinedStreamMessage;
        const candle = parseWsKlineMessage(msg);
        if (candle) this.emit("candle", candle);
      } catch (err) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    });

    ws.on("error", (err: Error) => {
      this.emit("error", err);
    });

    ws.on("close", (code: number, reasonBuf: Buffer) => {
      this.clearStallTimer();
      const reason = reasonBuf.toString("utf8");
      this.emit("close", code, reason);
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    const base = Math.min(this.backoffMaxMs, this.backoffMinMs * 2 ** (this.attempt - 1));
    const jitter = Math.random() * base * 0.25;
    const delay = Math.floor(base + jitter);
    this.emit("reconnect", this.attempt, delay);
    setTimeout(() => this.connect(), delay);
  }

  private resetStallTimer(): void {
    this.clearStallTimer();
    this.stallTimer = setTimeout(() => {
      this.emit("error", new Error(`No WS message in ${this.stallTimeoutMs}ms — forcing reconnect`));
      try {
        this.ws?.terminate();
      } catch {
        // noop
      }
    }, this.stallTimeoutMs);
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }
}

function rawDataToString(data: WebSocket.RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((b) => (Buffer.isBuffer(b) ? b : Buffer.from(b)))).toString("utf8");
  }
  // ArrayBuffer
  return Buffer.from(data).toString("utf8");
}

/**
 * Parse a combined-stream WS frame into a Candle — or null if it's
 * not a closed kline (partial updates, subscription acks, etc).
 */
export function parseWsKlineMessage(msg: unknown): Candle | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Partial<CombinedStreamMessage>;
  if (!m.data || m.data.e !== "kline" || !m.data.k) return null;
  const k = m.data.k;
  if (k.x !== true) return null; // only closed candles
  const symbol = k.s as TradingSymbol;
  return {
    symbol,
    openTime: k.t,
    closeTime: k.T,
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v),
  };
}
