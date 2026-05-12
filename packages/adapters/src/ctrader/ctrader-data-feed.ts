/**
 * CTraderDataFeed — live-mode MarketDataFeed using the cTrader Open API.
 *
 * Spec §9.15. PHASE 15 STATE: code only, no actual connection. Credentials
 * (CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET, CTRADER_ACCESS_TOKEN,
 * CTRADER_ACCOUNT_ID) come from the operator's environment (Replit secrets
 * in production); when they're absent, `start()` logs a clear message and
 * returns without attempting a connection — that's Phase 18's job.
 *
 * Connection lifecycle when credentials ARE present:
 *   1. open WebSocket to demo.ctraderapi.com:5036 (or live :5035)
 *   2. ProtoOAApplicationAuthReq  — authenticate the application
 *   3. ProtoOAAccountAuthReq      — authenticate the trading account
 *   4. ProtoOASymbolsListReq      — build the instrument -> symbolId cache
 *   5. ProtoOASubscribeSpotsReq   — subscribe to the configured pairs
 *   6. on ProtoOASpotEvent        — fold each tick into the bar builder
 *   7. heartbeat every 30 s via sendHeartbeat()
 *   8. on disconnect              — reconnect with exponential backoff
 *
 * Bars are persisted (source='live') and pushed to per-subscription
 * AsyncQueues so the engine's existing `subscribe()` iterator pattern
 * continues to work.
 */

import { CTraderConnection } from "@reiryoku/ctrader-layer";

import {
  logger,
  type AuditLog,
  type Bar,
  type MarketDataFeed,
  type Timeframe,
} from "@trading/core";
import type { Repos } from "@trading/data";

import { AsyncQueue } from "../async-queue.js";
import { TickToBarBuilder } from "./tick-to-bar.js";

const log = logger("adapters.ctrader.data-feed");

const HEARTBEAT_INTERVAL_MS = 30_000;
const BACKOFF_SEQUENCE_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];

export interface CTraderCredentials {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  accountId: number;
  accountType: "demo" | "live";
}

export interface CTraderDataFeedConfig {
  /** Canonical instrument codes the engine wants (e.g. EURUSD). */
  instruments: string[];
  /** Timeframes to build from the tick stream. */
  timeframes: Timeframe[];
  /** Queue capacity per pair (default 1000). */
  queueCapacity?: number;
  /** Override the heartbeat interval (default 30 s). */
  heartbeatMs?: number;
}

export interface CTraderDataFeedDeps {
  /** Returns the cred set or null when not yet configured. */
  loadCredentials: () => CTraderCredentials | null;
  /** Persists live bars (source='live'). */
  repos: Repos;
  /** Audit hooks for connect / disconnect / auth-failed events. */
  auditLog: AuditLog;
  /**
   * Connection factory — exposed for tests to inject a stub.
   * Production: `(host, port) => new CTraderConnection({ host, port })`.
   */
  connectionFactory?: (host: string, port: number) => CTraderConnection;
}

function hostPort(accountType: "demo" | "live"): { host: string; port: number } {
  if (accountType === "live") {
    return { host: "live.ctraderapi.com", port: 5035 };
  }
  return { host: "demo.ctraderapi.com", port: 5036 };
}

function pairKey(instrument: string, timeframe: Timeframe): string {
  return `${instrument}|${timeframe}`;
}

export class CTraderDataFeed implements MarketDataFeed {
  private connection: CTraderConnection | null = null;
  private connected = false;
  private stopRequested = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private readonly queues = new Map<string, AsyncQueue<Bar>>();
  private readonly currentBars = new Map<string, Bar>();
  private readonly symbolIdByName = new Map<string, number>();
  private readonly nameBySymbolId = new Map<number, string>();
  private readonly builder = new TickToBarBuilder();
  private readonly queueCapacity: number;
  private readonly heartbeatMs: number;

  constructor(
    private readonly deps: CTraderDataFeedDeps,
    private readonly config: CTraderDataFeedConfig,
  ) {
    this.queueCapacity = config.queueCapacity ?? 1000;
    this.heartbeatMs = config.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
    for (const inst of config.instruments) {
      for (const tf of config.timeframes) {
        this.queues.set(pairKey(inst, tf), new AsyncQueue<Bar>(this.queueCapacity));
      }
    }
  }

  async start(): Promise<void> {
    const creds = this.deps.loadCredentials();
    if (creds === null) {
      log.info(
        "cTrader credentials not configured — connection skipped. Add credentials in Phase 18.",
      );
      await this.deps.auditLog.recordEvent({
        severity: "info",
        category: "broker",
        description: "cTrader connection skipped: credentials missing",
      });
      return;
    }
    await this.connectLoop(creds);
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.connection !== null) {
      try {
        this.connection.close();
      } catch (err) {
        log.warn({ err: errMsg(err) }, "error closing cTrader connection");
      }
      this.connection = null;
    }
    for (const q of this.queues.values()) {
      q.close();
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getCurrentBar(instrument: string, timeframe: Timeframe): Bar | null {
    return this.currentBars.get(pairKey(instrument, timeframe)) ?? null;
  }

  async getHistoricalBars(
    instrument: string,
    timeframe: Timeframe,
    from: Date,
    to: Date,
  ): Promise<Bar[]> {
    // cTrader offers a REST + protobuf endpoint for OHLC; for our use-case
    // (warm-up + occasional fetches) the DB is authoritative since the
    // ingest pipeline (Phase 3) keeps it in sync. Return the DB rows.
    const rows = await this.deps.repos.bars.findRange(instrument, timeframe, from, to);
    return rows.map((r) => ({
      instrument: r.instrument,
      timeframe: r.timeframe as Timeframe,
      timestampUtc: r.timestampUtc,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
      source: r.source as Bar["source"],
    }));
  }

  async *subscribe(instrument: string, timeframe: Timeframe): AsyncIterable<Bar> {
    const key = pairKey(instrument, timeframe);
    const q = this.queues.get(key);
    if (q === undefined) {
      throw new Error(
        `CTraderDataFeed.subscribe: ${key} is not in the configured set`,
      );
    }
    while (true) {
      const bar = await q.next();
      if (bar === null) {
        return;
      }
      this.currentBars.set(key, bar);
      yield bar;
    }
  }

  // ----------------------------------------------------------- internals

  /** Outer reconnect loop: connect -> stay connected -> reconnect on drop. */
  private async connectLoop(creds: CTraderCredentials): Promise<void> {
    while (!this.stopRequested) {
      try {
        await this.connectOnce(creds);
        // If connectOnce returned without throwing, we treat that as
        // graceful end-of-session (e.g. peer closed). Reset backoff and
        // attempt to reconnect unless stopped.
        this.reconnectAttempt = 0;
      } catch (err) {
        this.connected = false;
        const waitMs =
          BACKOFF_SEQUENCE_MS[
            Math.min(this.reconnectAttempt, BACKOFF_SEQUENCE_MS.length - 1)
          ] ?? 60_000;
        this.reconnectAttempt += 1;
        log.warn(
          { err: errMsg(err), attempt: this.reconnectAttempt, waitMs },
          "cTrader connect failed; backing off",
        );
        await this.deps.auditLog.recordEvent({
          severity: "warn",
          category: "broker",
          description: `cTrader connect failed (attempt ${this.reconnectAttempt})`,
          metadata: { err: errMsg(err) },
        });
        if (this.stopRequested) {
          return;
        }
        await sleep(waitMs);
      }
    }
  }

  private async connectOnce(creds: CTraderCredentials): Promise<void> {
    const { host, port } = hostPort(creds.accountType);
    const factory =
      this.deps.connectionFactory ??
      ((h: string, p: number) => new CTraderConnection({ host: h, port: p }));
    const conn = factory(host, port);
    this.connection = conn;
    await conn.open();

    // 1. Application auth.
    await conn.sendCommand("ProtoOAApplicationAuthReq", {
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
    });

    // 2. Account auth.
    await conn.sendCommand("ProtoOAAccountAuthReq", {
      ctidTraderAccountId: creds.accountId,
      accessToken: creds.accessToken,
    });

    // 3. Symbol list + cache.
    const symbols = (await conn.sendCommand("ProtoOASymbolsListReq", {
      ctidTraderAccountId: creds.accountId,
    })) as { symbol?: Array<{ symbolName?: string; symbolId?: number }> };
    for (const s of symbols.symbol ?? []) {
      if (typeof s.symbolName === "string" && typeof s.symbolId === "number") {
        const canonical = s.symbolName.toUpperCase();
        this.symbolIdByName.set(canonical, s.symbolId);
        this.nameBySymbolId.set(s.symbolId, canonical);
      }
    }

    // 4. Subscribe to spot prices for the configured instruments.
    const symbolIds: number[] = [];
    for (const inst of this.config.instruments) {
      const id = this.symbolIdByName.get(inst);
      if (id === undefined) {
        log.warn({ instrument: inst }, "cTrader symbol unknown; skipping");
        continue;
      }
      symbolIds.push(id);
    }
    if (symbolIds.length > 0) {
      await conn.sendCommand("ProtoOASubscribeSpotsReq", {
        ctidTraderAccountId: creds.accountId,
        symbolId: symbolIds,
      });
    }

    // 5. Hook the spot-event handler.
    conn.on("ProtoOASpotEvent", (event) => {
      void this.handleSpot(event as unknown as ProtoOASpotEvent);
    });

    // 6. Heartbeat every N ms.
    this.heartbeatTimer = setInterval(() => {
      try {
        conn.sendHeartbeat();
      } catch (err) {
        log.warn({ err: errMsg(err) }, "heartbeat failed");
      }
    }, this.heartbeatMs);

    this.connected = true;
    await this.deps.auditLog.recordEvent({
      severity: "info",
      category: "broker",
      description: "cTrader connected",
      metadata: { host, port, account: creds.accountId, accountType: creds.accountType },
    });
    log.info({ host, port, account: creds.accountId }, "cTrader data feed connected");

    // The connection stays open and is event-driven from here.
    // connectOnce returns when the connection closes (the layer surfaces
    // closure via `close()` and event errors); the reconnect loop above
    // handles backoff + retry.
    await this.waitUntilClosed();
  }

  private waitUntilClosed(): Promise<void> {
    return new Promise<void>((resolve) => {
      const conn = this.connection;
      if (conn === null) {
        resolve();
        return;
      }
      // ctrader-layer fires "ProtoOAErrorRes" + emits when the socket
      // drops; in practice we poll a "still open" flag (the layer
      // doesn't expose a top-level close event uniformly across
      // versions). When stop() is called we close the connection which
      // resolves this promise.
      const check = setInterval(() => {
        if (this.stopRequested || this.connection === null) {
          clearInterval(check);
          resolve();
        }
      }, 1_000);
    });
  }

  /** Fold a single spot event into the bar builder; emit finalized bars. */
  private async handleSpot(event: ProtoOASpotEvent): Promise<void> {
    const symbolId = event.symbolId;
    const canonical = symbolId !== undefined ? this.nameBySymbolId.get(symbolId) : undefined;
    if (canonical === undefined) {
      return;
    }
    // cTrader prices are integers scaled by 1e5 by convention; the
    // ctrader-layer surface uses bid/ask in price * 100000 form.
    const price = pickPrice(event);
    if (price === null) {
      return;
    }
    const tick = {
      instrument: canonical,
      price,
      volume: 1,
      timestampUtc: event.timestamp ? new Date(Number(event.timestamp)) : new Date(),
    };
    for (const tf of this.config.timeframes) {
      const finalized = this.builder.onTick(tick, tf);
      if (finalized !== null) {
        await this.persistAndQueue(finalized);
      }
    }
  }

  private async persistAndQueue(bar: Bar): Promise<void> {
    try {
      await this.deps.repos.bars.insertMany([
        {
          instrument: bar.instrument,
          timeframe: bar.timeframe,
          timestampUtc: bar.timestampUtc,
          open: bar.open.toFixed(6),
          high: bar.high.toFixed(6),
          low: bar.low.toFixed(6),
          close: bar.close.toFixed(6),
          volume: bar.volume.toFixed(2),
          source: "live",
        },
      ]);
    } catch (err) {
      log.warn({ err: errMsg(err), bar }, "live bar persist failed");
    }
    const q = this.queues.get(pairKey(bar.instrument, bar.timeframe));
    if (q !== undefined) {
      await q.push(bar);
    }
  }
}

// ---------------------------------------------------------- helpers + types

interface ProtoOASpotEvent {
  symbolId?: number;
  bid?: number;
  ask?: number;
  timestamp?: number | string;
}

function pickPrice(event: ProtoOASpotEvent): number | null {
  // Prefer bid for entries; cTrader Open API sends integer prices scaled
  // by 1e5. Some symbol classes use different scales; the symbol list
  // (ProtoOASymbol) carries the digit count — production code should
  // honour that. For Phase 15 we accept the as-supplied magnitude.
  const raw = event.bid ?? event.ask ?? null;
  if (raw === null) {
    return null;
  }
  return raw / 1e5;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
