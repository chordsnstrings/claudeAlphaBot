/**
 * Phase 17 query layer: loaders used by the non-dashboard pages.
 * Same try/catch graceful-degradation pattern as `queries.ts` —
 * every loader returns a safe empty shape so pages render even when
 * the DB is reachable but has no rows yet.
 */
import { db } from "./pool";

export interface ActivityEvent {
  readonly timestampUtc: number;
  readonly kind: string;
  readonly symbol: string | null;
  readonly detail: string;
}

/**
 * Denormalised stream of recent bot events from several tables:
 * regime_check_log, revalidation_events, circuit_breaker_events,
 * trades (exits), open_positions (entries). Sorted newest first.
 */
export async function loadActivityFeed(limit = 100): Promise<ActivityEvent[]> {
  try {
    const [reg, reval, cb, trades, pos] = await Promise.all([
      db().query<{ timestamp_utc: string; symbol: string; outcome: string }>(
        `SELECT timestamp_utc::text, symbol, outcome
           FROM regime_check_log ORDER BY timestamp_utc DESC LIMIT 40`,
      ),
      db().query<{ started_at_utc: string; trigger_reason: string }>(
        `SELECT started_at_utc::text, trigger_reason
           FROM revalidation_events ORDER BY started_at_utc DESC LIMIT 10`,
      ),
      db().query<{ timestamp_utc: string; kind: string; symbol: string | null }>(
        `SELECT timestamp_utc::text, kind, symbol
           FROM circuit_breaker_events ORDER BY timestamp_utc DESC LIMIT 20`,
      ),
      db().query<{
        exit_time: string;
        symbol: string;
        exit_reason: string;
        pnl_usd: string;
      }>(
        `SELECT exit_time::text, symbol, exit_reason, pnl_usd::text
           FROM trades ORDER BY exit_time DESC LIMIT 40`,
      ),
      db().query<{ entry_time: string; symbol: string; strategy: string; direction: string }>(
        `SELECT entry_time::text, symbol, strategy, direction
           FROM open_positions ORDER BY entry_time DESC LIMIT 20`,
      ),
    ]);

    const events: ActivityEvent[] = [];
    for (const r of reg.rows)
      events.push({
        timestampUtc: Number(r.timestamp_utc),
        kind: `REGIME_${r.outcome}`,
        symbol: r.symbol,
        detail: `outcome ${r.outcome}`,
      });
    for (const r of reval.rows)
      events.push({
        timestampUtc: Number(r.started_at_utc),
        kind: "REVALIDATION",
        symbol: null,
        detail: `trigger: ${r.trigger_reason}`,
      });
    for (const r of cb.rows)
      events.push({
        timestampUtc: Number(r.timestamp_utc),
        kind: `BREAKER_${r.kind}`,
        symbol: r.symbol ?? null,
        detail: `circuit: ${r.kind}`,
      });
    for (const r of trades.rows)
      events.push({
        timestampUtc: Number(r.exit_time),
        kind: `TRADE_${r.exit_reason}`,
        symbol: r.symbol,
        detail: `PnL ${Number(r.pnl_usd).toFixed(2)}`,
      });
    for (const r of pos.rows)
      events.push({
        timestampUtc: Number(r.entry_time),
        kind: "POSITION_OPENED",
        symbol: r.symbol,
        detail: `${r.direction} ${r.strategy}`,
      });

    events.sort((a, b) => b.timestampUtc - a.timestampUtc);
    return events.slice(0, limit);
  } catch {
    return [];
  }
}

export interface TradeRow {
  readonly tradeId: number;
  readonly mode: string;
  readonly symbol: string;
  readonly strategy: string;
  readonly direction: "LONG" | "SHORT";
  readonly entryTimeUtc: number;
  readonly exitTimeUtc: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly quantity: number;
  readonly pnlUsd: number;
  readonly pnlR: number;
  readonly exitReason: string;
  readonly feesPaid: number;
}

export async function loadAllTrades(limit = 500): Promise<TradeRow[]> {
  try {
    const res = await db().query<{
      trade_id: string;
      mode: string;
      symbol: string;
      strategy: string;
      direction: "LONG" | "SHORT";
      entry_time: string;
      exit_time: string;
      entry_price: string;
      exit_price: string;
      quantity: string;
      pnl_usd: string;
      pnl_r: string;
      exit_reason: string;
      fees_paid: string;
    }>(
      `SELECT trade_id::text, mode, symbol, strategy, direction,
              entry_time::text, exit_time::text,
              entry_price::text, exit_price::text, quantity::text,
              pnl_usd::text, pnl_r::text, exit_reason, fees_paid::text
         FROM trades ORDER BY exit_time DESC LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => ({
      tradeId: Number(r.trade_id),
      mode: r.mode,
      symbol: r.symbol,
      strategy: r.strategy,
      direction: r.direction,
      entryTimeUtc: Number(r.entry_time),
      exitTimeUtc: Number(r.exit_time),
      entryPrice: Number(r.entry_price),
      exitPrice: Number(r.exit_price),
      quantity: Number(r.quantity),
      pnlUsd: Number(r.pnl_usd),
      pnlR: Number(r.pnl_r),
      exitReason: r.exit_reason,
      feesPaid: Number(r.fees_paid),
    }));
  } catch {
    return [];
  }
}

export interface PerformanceMetrics {
  readonly totalTrades: number;
  readonly winRatePct: number;
  readonly totalPnlUsd: number;
  readonly avgRPerTrade: number;
  readonly bestRMultiple: number;
  readonly worstRMultiple: number;
  readonly profitFactor: number;
}

export async function loadPerformance(
  fromUtc: number,
  toUtc: number,
): Promise<PerformanceMetrics> {
  try {
    const res = await db().query<{ pnl_usd: string; pnl_r: string }>(
      `SELECT pnl_usd::text, pnl_r::text
         FROM trades WHERE exit_time BETWEEN $1 AND $2`,
      [fromUtc, toUtc],
    );
    const ts = res.rows.map((r) => ({
      pnl: Number(r.pnl_usd),
      r: Number(r.pnl_r),
    }));
    if (ts.length === 0)
      return {
        totalTrades: 0,
        winRatePct: 0,
        totalPnlUsd: 0,
        avgRPerTrade: 0,
        bestRMultiple: 0,
        worstRMultiple: 0,
        profitFactor: 0,
      };
    const wins = ts.filter((t) => t.pnl > 0);
    const losses = ts.filter((t) => t.pnl < 0);
    const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
    return {
      totalTrades: ts.length,
      winRatePct: (wins.length / ts.length) * 100,
      totalPnlUsd: ts.reduce((a, t) => a + t.pnl, 0),
      avgRPerTrade: ts.reduce((a, t) => a + t.r, 0) / ts.length,
      bestRMultiple: Math.max(...ts.map((t) => t.r)),
      worstRMultiple: Math.min(...ts.map((t) => t.r)),
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    };
  } catch {
    return {
      totalTrades: 0,
      winRatePct: 0,
      totalPnlUsd: 0,
      avgRPerTrade: 0,
      bestRMultiple: 0,
      worstRMultiple: 0,
      profitFactor: 0,
    };
  }
}

export interface StrategyBreakdown {
  readonly strategy: string;
  readonly trades: number;
  readonly wins: number;
  readonly totalPnlUsd: number;
  readonly avgR: number;
}

export async function loadStrategyBreakdown(): Promise<StrategyBreakdown[]> {
  try {
    const res = await db().query<{
      strategy: string;
      trades: string;
      wins: string;
      pnl: string;
      avg_r: string;
    }>(
      `SELECT strategy,
              COUNT(*)::text AS trades,
              SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END)::text AS wins,
              COALESCE(SUM(pnl_usd), 0)::text AS pnl,
              COALESCE(AVG(pnl_r), 0)::text AS avg_r
         FROM trades GROUP BY strategy ORDER BY strategy`,
    );
    return res.rows.map((r) => ({
      strategy: r.strategy,
      trades: Number(r.trades),
      wins: Number(r.wins),
      totalPnlUsd: Number(r.pnl),
      avgR: Number(r.avg_r),
    }));
  } catch {
    return [];
  }
}

export interface RegimeLogRow {
  readonly timestampUtc: number;
  readonly symbol: string;
  readonly currentRegime: string;
  readonly validationRegime: string;
  readonly outcome: "UNCHANGED" | "DRIFTED" | "FLIPPED";
  readonly confidenceDeltaPct: number;
}

export async function loadRegimeLog(limit = 200): Promise<RegimeLogRow[]> {
  try {
    const res = await db().query<{
      timestamp_utc: string;
      symbol: string;
      current_regime: string;
      validation_regime: string;
      outcome: "UNCHANGED" | "DRIFTED" | "FLIPPED";
      confidence_delta_pct: string;
    }>(
      `SELECT timestamp_utc::text, symbol, current_regime, validation_regime,
              outcome, confidence_delta_pct::text
         FROM regime_check_log ORDER BY timestamp_utc DESC LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => ({
      timestampUtc: Number(r.timestamp_utc),
      symbol: r.symbol,
      currentRegime: r.current_regime,
      validationRegime: r.validation_regime,
      outcome: r.outcome,
      confidenceDeltaPct: Number(r.confidence_delta_pct),
    }));
  } catch {
    return [];
  }
}

export interface ArtifactRow {
  readonly artifactHash: string;
  readonly createdAtUtc: number;
  readonly compositeScore: number;
  readonly deploymentAllowed: boolean;
  readonly codeHash: string;
  readonly isActive: boolean;
}

export async function loadArtifacts(): Promise<ArtifactRow[]> {
  try {
    const res = await db().query<{
      artifact_hash: string;
      created_at_utc: string;
      composite_score: string;
      deployment_allowed: boolean;
      code_hash: string;
      is_active: boolean;
    }>(
      `SELECT artifact_hash, created_at_utc::text, composite_score::text,
              deployment_allowed, code_hash, is_active
         FROM validated_artifacts ORDER BY created_at_utc DESC LIMIT 50`,
    );
    return res.rows.map((r) => ({
      artifactHash: r.artifact_hash,
      createdAtUtc: Number(r.created_at_utc),
      compositeScore: Number(r.composite_score),
      deploymentAllowed: r.deployment_allowed,
      codeHash: r.code_hash,
      isActive: r.is_active,
    }));
  } catch {
    return [];
  }
}

export interface BreakerEvent {
  readonly timestampUtc: number;
  readonly kind: string;
  readonly symbol: string | null;
  readonly triggeredByPnlPct: number | null;
  readonly accountEquity: number;
  readonly action: string;
  readonly releasedAtUtc: number | null;
}

export async function loadBreakerEvents(): Promise<BreakerEvent[]> {
  try {
    const res = await db().query<{
      timestamp_utc: string;
      kind: string;
      symbol: string | null;
      triggered_by_pnl_pct: string | null;
      account_equity: string;
      action: string;
      released_at_utc: string | null;
    }>(
      `SELECT timestamp_utc::text, kind, symbol,
              triggered_by_pnl_pct::text, account_equity::text,
              action, released_at_utc::text
         FROM circuit_breaker_events ORDER BY timestamp_utc DESC LIMIT 100`,
    );
    return res.rows.map((r) => ({
      timestampUtc: Number(r.timestamp_utc),
      kind: r.kind,
      symbol: r.symbol,
      triggeredByPnlPct: r.triggered_by_pnl_pct ? Number(r.triggered_by_pnl_pct) : null,
      accountEquity: Number(r.account_equity),
      action: r.action,
      releasedAtUtc: r.released_at_utc ? Number(r.released_at_utc) : null,
    }));
  } catch {
    return [];
  }
}

export interface CommandLogRow {
  readonly timestampUtc: number;
  readonly command: string;
  readonly requester: string | null;
  readonly result: string;
  readonly errorMessage: string | null;
}

export async function loadCommandLog(limit = 50): Promise<CommandLogRow[]> {
  try {
    const res = await db().query<{
      timestamp_utc: string;
      command: string;
      requester: string | null;
      result: string;
      error_message: string | null;
    }>(
      `SELECT timestamp_utc::text, command, requester, result, error_message
         FROM command_log ORDER BY timestamp_utc DESC LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => ({
      timestampUtc: Number(r.timestamp_utc),
      command: r.command,
      requester: r.requester,
      result: r.result,
      errorMessage: r.error_message,
    }));
  } catch {
    return [];
  }
}
