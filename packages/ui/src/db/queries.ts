/**
 * Server-side DB queries for the UI. All functions are `async` and
 * expected to be called from Server Components (or Route Handlers).
 *
 * Graceful degradation: when the bot hasn't written any rows yet —
 * e.g. fresh install — these return empty arrays / zero-valued
 * shapes rather than throwing. The dashboard then renders "No
 * activity yet" empty states instead of an error page.
 */
import { db } from "./pool";

export interface KpiSnapshot {
  readonly equityUsd: number;
  readonly todayPct: number;
  readonly weekPct: number;
  readonly allTimePct: number;
  readonly todayTrades: number;
  readonly weekWins: number;
  readonly winRatePct: number;
}

export async function loadKpis(startingEquityUsd: number): Promise<KpiSnapshot> {
  try {
    const now = Date.now();
    const dayAgo = now - 86_400_000;
    const weekAgo = now - 7 * 86_400_000;
    const [eq, trades] = await Promise.all([
      db().query<{ equity_usd: string }>(
        `SELECT equity_usd FROM account_equity_history
          ORDER BY timestamp_utc DESC LIMIT 1`,
      ),
      db().query<{
        pnl_usd: string;
        exit_time_utc: string;
        exit_reason: string;
      }>(
        `SELECT pnl_usd::text, exit_time_utc::text, exit_reason
           FROM trades ORDER BY exit_time_utc DESC LIMIT 500`,
      ),
    ]);
    const latestEquity = eq.rows[0]
      ? Number(eq.rows[0].equity_usd)
      : startingEquityUsd;
    const tradesList = trades.rows.map((r) => ({
      pnl: Number(r.pnl_usd),
      exit: Number(r.exit_time_utc),
      reason: r.exit_reason,
    }));
    const todayTrades = tradesList.filter((t) => t.exit >= dayAgo);
    const weekTrades = tradesList.filter((t) => t.exit >= weekAgo);
    const weekWins = weekTrades.filter((t) => t.pnl > 0).length;
    const todayPct =
      todayTrades.reduce((acc, t) => acc + t.pnl, 0) / Math.max(latestEquity, 1);
    const weekPct =
      weekTrades.reduce((acc, t) => acc + t.pnl, 0) / Math.max(latestEquity, 1);
    const allTimePct = (latestEquity - startingEquityUsd) / Math.max(startingEquityUsd, 1);
    const winRatePct =
      tradesList.length === 0
        ? 0
        : (tradesList.filter((t) => t.pnl > 0).length / tradesList.length) * 100;
    return {
      equityUsd: latestEquity,
      todayPct: todayPct * 100,
      weekPct: weekPct * 100,
      allTimePct: allTimePct * 100,
      todayTrades: todayTrades.length,
      weekWins,
      winRatePct,
    };
  } catch {
    return {
      equityUsd: startingEquityUsd,
      todayPct: 0,
      weekPct: 0,
      allTimePct: 0,
      todayTrades: 0,
      weekWins: 0,
      winRatePct: 0,
    };
  }
}

export interface EquityPoint {
  readonly timestampUtc: number;
  readonly equityUsd: number;
}

export async function loadEquityCurve(days: number): Promise<EquityPoint[]> {
  try {
    const sinceMs = Date.now() - days * 86_400_000;
    const res = await db().query<{ timestamp_utc: string; equity_usd: string }>(
      `SELECT timestamp_utc::text, equity_usd::text
         FROM account_equity_history
        WHERE timestamp_utc >= $1
        ORDER BY timestamp_utc ASC`,
      [sinceMs],
    );
    return res.rows.map((r) => ({
      timestampUtc: Number(r.timestamp_utc),
      equityUsd: Number(r.equity_usd),
    }));
  } catch {
    return [];
  }
}

export interface OpenPositionRow {
  readonly id: string;
  readonly symbol: string;
  readonly direction: "LONG" | "SHORT";
  readonly entryTime: number;
  readonly entryPrice: number;
  readonly quantity: number;
  readonly stopPrice: number;
  readonly tp1Price: number;
  readonly tp2Price: number;
  readonly strategy: string;
}

export async function loadOpenPositions(): Promise<OpenPositionRow[]> {
  try {
    const res = await db().query<{
      id: string;
      symbol: string;
      direction: "LONG" | "SHORT";
      entry_time: string;
      entry_price: string;
      quantity: string;
      stop_price: string;
      tp1_price: string;
      tp2_price: string;
      strategy: string;
    }>(
      `SELECT id, symbol, direction,
              entry_time::text, entry_price::text, quantity::text,
              stop_price::text, tp1_price::text, tp2_price::text, strategy
         FROM open_positions ORDER BY entry_time DESC LIMIT 20`,
    );
    return res.rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      direction: r.direction,
      entryTime: Number(r.entry_time),
      entryPrice: Number(r.entry_price),
      quantity: Number(r.quantity),
      stopPrice: Number(r.stop_price),
      tp1Price: Number(r.tp1_price),
      tp2Price: Number(r.tp2_price),
      strategy: r.strategy,
    }));
  } catch {
    return [];
  }
}

export interface RecentTradeRow {
  readonly tradeId: number;
  readonly exitTimeUtc: number;
  readonly symbol: string;
  readonly strategy: string;
  readonly direction: "LONG" | "SHORT";
  readonly pnlUsd: number;
  readonly exitReason: string;
}

export async function loadRecentTrades(limit = 10): Promise<RecentTradeRow[]> {
  try {
    const res = await db().query<{
      trade_id: string;
      exit_time_utc: string;
      symbol: string;
      strategy: string;
      direction: "LONG" | "SHORT";
      pnl_usd: string;
      exit_reason: string;
    }>(
      `SELECT trade_id::text, exit_time_utc::text, symbol, strategy, direction,
              pnl_usd::text, exit_reason
         FROM trades ORDER BY exit_time_utc DESC LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => ({
      tradeId: Number(r.trade_id),
      exitTimeUtc: Number(r.exit_time_utc),
      symbol: r.symbol,
      strategy: r.strategy,
      direction: r.direction,
      pnlUsd: Number(r.pnl_usd),
      exitReason: r.exit_reason,
    }));
  } catch {
    return [];
  }
}

export interface RegimeStatus {
  readonly symbol: string;
  readonly currentRegime: string;
  readonly outcome: "UNCHANGED" | "DRIFTED" | "FLIPPED" | null;
  readonly confidence: number | null;
  readonly lastCheckUtc: number | null;
}

export async function loadRegimeStatus(): Promise<RegimeStatus[]> {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  try {
    const out: RegimeStatus[] = [];
    for (const sym of symbols) {
      const res = await db().query<{
        timestamp_utc: string;
        current_regime: string;
        outcome: "UNCHANGED" | "DRIFTED" | "FLIPPED";
        confidence_current: string;
      }>(
        `SELECT timestamp_utc::text, current_regime, outcome, confidence_current::text
           FROM regime_check_log WHERE symbol = $1
           ORDER BY timestamp_utc DESC LIMIT 1`,
        [sym],
      );
      const r = res.rows[0];
      out.push({
        symbol: sym,
        currentRegime: r?.current_regime ?? "—",
        outcome: r?.outcome ?? null,
        confidence: r ? Number(r.confidence_current) : null,
        lastCheckUtc: r ? Number(r.timestamp_utc) : null,
      });
    }
    return out;
  } catch {
    return symbols.map((s) => ({
      symbol: s,
      currentRegime: "—",
      outcome: null,
      confidence: null,
      lastCheckUtc: null,
    }));
  }
}

export interface StatusInfo {
  readonly mode: string;
  readonly bootTimeMs: number;
  readonly lastRegimeCheckIso: string | null;
}

export async function loadStatus(): Promise<StatusInfo> {
  try {
    const res = await db().query<{ timestamp_utc: string }>(
      `SELECT timestamp_utc::text FROM regime_check_log
        ORDER BY timestamp_utc DESC LIMIT 1`,
    );
    const lastMs = res.rows[0] ? Number(res.rows[0].timestamp_utc) : null;
    return {
      mode: process.env["BOT_MODE"] ?? "backtest",
      // Without an RPC to the bot we can't know boot time; use process start.
      bootTimeMs: Date.now() - (process.uptime() * 1000),
      lastRegimeCheckIso: lastMs ? new Date(lastMs).toISOString() : null,
    };
  } catch {
    return {
      mode: process.env["BOT_MODE"] ?? "backtest",
      bootTimeMs: Date.now(),
      lastRegimeCheckIso: null,
    };
  }
}
