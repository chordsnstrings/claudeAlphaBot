/**
 * Page view functions. Each takes a typed model and returns the inner
 * HTML body; the layout wrapper adds nav + chrome.
 */

import type {
  AccountInfo,
  Position,
  RiskConfig,
} from "@trading/core";
import type { AuditEventRow, SessionRow, TradeRow } from "@trading/data";
import type { StrategyState } from "@trading/risk";

import { escape } from "./layout.js";

// --------------------------------------------------------------- Login

export function loginPage(opts: { error?: string | null }): string {
  return `
  <section class="card" style="max-width: 360px; margin: 80px auto;">
    <h1 style="margin-bottom: 4px;">Sign in</h1>
    <p class="muted" style="margin-top: 0;">Trading system operations console.</p>
    ${opts.error === null || opts.error === undefined ? "" : `<p class="bad">${escape(opts.error)}</p>`}
    <form method="POST" action="/login">
      <label>Username</label>
      <input type="text" name="username" autocomplete="username" autofocus required style="width: 100%; margin-bottom: 12px;" />
      <label>Password</label>
      <input type="password" name="password" autocomplete="current-password" required style="width: 100%; margin-bottom: 16px;" />
      <button class="accent" type="submit" style="width: 100%;">Sign in</button>
    </form>
  </section>`;
}

// --------------------------------------------------------- Dashboard

export interface DashboardModel {
  account: AccountInfo | null;
  positions: Position[];
  strategies: Record<string, StrategyState>;
  recentEvents: AuditEventRow[];
}

export function dashboardPage(m: DashboardModel): string {
  const acc = m.account;
  const equity = acc?.equityUsd ?? 0;
  const unrealizedClass = (acc?.unrealizedPnlUsd ?? 0) >= 0 ? "good" : "bad";
  return `
  <h1>Dashboard</h1>

  <section class="card">
    <div class="grid-3">
      <div>
        <div class="stat-label">Equity</div>
        <div class="stat num">$${fmtNum(equity, 2)}</div>
        <div class="muted">${acc === null ? "no live session" : acc.accountType.toUpperCase()}</div>
      </div>
      <div>
        <div class="stat-label">Unrealized P&amp;L</div>
        <div class="stat num ${unrealizedClass}">$${fmtNum(acc?.unrealizedPnlUsd ?? 0, 2)}</div>
        <div class="muted num">${fmtNum(acc?.unrealizedPnlPct ?? 0, 2)}%</div>
      </div>
      <div>
        <div class="stat-label">Open positions</div>
        <div class="stat num">${acc?.openPositionsCount ?? m.positions.length}</div>
        <div class="muted num">total risk: ${fmtNum(acc?.totalOpenRiskPct ?? 0, 2)}%</div>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>Open positions</h2>
    ${
      m.positions.length === 0
        ? `<p class="muted">No open positions.</p>`
        : `<table>
      <thead><tr>
        <th>Instrument</th><th>Side</th><th>Lots</th>
        <th>Entry</th><th>Stop</th><th>Target</th>
        <th>Strategy</th><th>P&amp;L</th><th></th>
      </tr></thead>
      <tbody>
      ${m.positions
        .map(
          (p) => `
        <tr>
          <td>${escape(p.instrument)}</td>
          <td>${p.direction === "long" ? "LONG" : "SHORT"}</td>
          <td class="num">${fmtNum(p.lotSize, 2)}</td>
          <td class="num">${fmtNum(p.entryPrice, 6)}</td>
          <td class="num">${fmtNum(p.currentStopPrice, 6)}</td>
          <td class="num">${fmtNum(p.currentTargetPrice, 6)}</td>
          <td class="muted">${escape(p.originatingStrategy)}</td>
          <td class="num ${p.unrealizedPnLUsd >= 0 ? "good" : "bad"}">$${fmtNum(p.unrealizedPnLUsd, 2)}</td>
          <td>
            <form method="POST" action="/api/close-position" class="inline"
                  onsubmit="return confirm('Close ${escape(p.instrument)} ${p.direction.toUpperCase()}?')">
              <input type="hidden" name="positionId" value="${escape(p.id)}" />
              <button type="submit">Close</button>
            </form>
          </td>
        </tr>`,
        )
        .join("")}
      </tbody></table>`
    }
  </section>

  <section class="card">
    <h2>Strategies</h2>
    ${
      Object.keys(m.strategies).length === 0
        ? `<p class="muted">No strategies registered.</p>`
        : `<table>
      <thead><tr><th>Name</th><th>State</th><th>Actions</th></tr></thead>
      <tbody>
      ${Object.entries(m.strategies)
        .map(
          ([name, state]) => `
        <tr>
          <td>${escape(name)}</td>
          <td>${stateBadge(state)}</td>
          <td>
            ${strategyActions(name, state)}
          </td>
        </tr>`,
        )
        .join("")}
      </tbody></table>`
    }
  </section>

  <section class="card">
    <h2>Recent events</h2>
    ${
      m.recentEvents.length === 0
        ? `<p class="muted">No events yet.</p>`
        : `<table>
      <thead><tr><th>When</th><th>Category</th><th>Severity</th><th>Description</th></tr></thead>
      <tbody>
      ${m.recentEvents
        .slice(0, 20)
        .map(
          (e) => `
        <tr>
          <td class="muted num">${escape(e.createdAt.toISOString().replace("T", " ").slice(0, 19))}</td>
          <td>${escape(e.category)}</td>
          <td>${severityBadge(e.severity)}</td>
          <td>${escape(e.description)}</td>
        </tr>`,
        )
        .join("")}
      </tbody></table>`
    }
  </section>

  <script>
    // SSE for live position P&L updates. Reconnects automatically.
    if (typeof EventSource !== 'undefined') {
      const es = new EventSource('/events');
      es.addEventListener('refresh', () => location.reload());
    }
  </script>`;
}

function strategyActions(name: string, state: StrategyState): string {
  if (state === "killed") {
    return `<span class="muted">killed</span>`;
  }
  const nameEsc = escape(name);
  if (state === "paused") {
    return `
      <form method="POST" action="/api/strategy/resume" class="inline">
        <input type="hidden" name="name" value="${nameEsc}" />
        <button type="submit">Resume</button>
      </form>
      <form method="POST" action="/api/strategy/kill" class="inline"
            onsubmit="return confirm('Kill ${nameEsc}? This closes its open positions.')">
        <input type="hidden" name="name" value="${nameEsc}" />
        <input type="hidden" name="reason" value="manual kill" />
        <button type="submit">Kill</button>
      </form>`;
  }
  return `
    <form method="POST" action="/api/strategy/pause" class="inline">
      <input type="hidden" name="name" value="${nameEsc}" />
      <input type="hidden" name="reason" value="manual pause" />
      <button type="submit">Pause</button>
    </form>
    <form method="POST" action="/api/strategy/kill" class="inline"
          onsubmit="return confirm('Kill ${nameEsc}? This closes its open positions.')">
      <input type="hidden" name="name" value="${nameEsc}" />
      <input type="hidden" name="reason" value="manual kill" />
      <button type="submit">Kill</button>
    </form>`;
}

function stateBadge(state: StrategyState): string {
  if (state === "running") {return `<span class="good">● running</span>`;}
  if (state === "paused") {return `<span class="warn" style="color: var(--warn);">● paused</span>`;}
  return `<span class="bad">● killed</span>`;
}

function severityBadge(s: string): string {
  if (s === "fatal" || s === "error") {return `<span class="bad">${escape(s)}</span>`;}
  if (s === "warn") {return `<span style="color: var(--warn);">${escape(s)}</span>`;}
  return `<span class="muted">${escape(s)}</span>`;
}

// ------------------------------------------------------- Backtest list

export interface BacktestRow {
  id: string;
  createdAt: Date;
  status: string;
  sessionType: string;
  tradeCount: number;
  instruments: string[];
  timeframes: string[];
  strategies: unknown;
  initialEquityUsd: string;
  currentEquityUsd: string;
}

export function backtestsPage(rows: BacktestRow[]): string {
  return `
  <h1>Backtests</h1>
  <section class="card">
    ${
      rows.length === 0
        ? `<p class="muted">No backtest sessions yet. Run <code>pnpm --filter @trading/cli backtest ...</code> to create one.</p>`
        : `<table>
      <thead><tr>
        <th>Created</th><th>Type</th><th>Status</th>
        <th>Instruments</th><th>Trades</th>
        <th>Return</th><th></th>
      </tr></thead>
      <tbody>
      ${rows
        .map((r) => {
          const start = Number(r.initialEquityUsd);
          const end = Number(r.currentEquityUsd);
          const pct = start === 0 ? 0 : ((end - start) / start) * 100;
          const cls = pct >= 0 ? "good" : "bad";
          return `
          <tr>
            <td class="muted num">${escape(r.createdAt.toISOString().replace("T", " ").slice(0, 19))}</td>
            <td>${escape(r.sessionType)}</td>
            <td>${escape(r.status)}</td>
            <td>${escape(r.instruments.join(", "))}</td>
            <td class="num">${r.tradeCount}</td>
            <td class="num ${cls}">${fmtNum(pct, 2)}%</td>
            <td><a href="/backtests/${escape(r.id)}">view</a></td>
          </tr>`;
        })
        .join("")}
      </tbody></table>`
    }
  </section>`;
}

export function backtestDetailPage(opts: {
  session: SessionRow;
  trades: TradeRow[];
  events: AuditEventRow[];
}): string {
  const s = opts.session;
  const metrics = s.aggregateMetrics as Record<string, unknown> | null;
  return `
  <h1>Backtest <span class="muted num">${escape(s.id.slice(0, 8))}</span></h1>

  <section class="card">
    <div class="grid-3">
      <div><div class="stat-label">Status</div><div class="stat">${escape(s.status)}</div></div>
      <div><div class="stat-label">Trades</div><div class="stat num">${s.tradeCount}</div></div>
      <div><div class="stat-label">Final equity</div><div class="stat num">$${fmtNum(Number(s.currentEquityUsd), 2)}</div></div>
    </div>
    <p class="muted" style="margin-top: 12px;">
      Range: ${escape(s.dateRangeFrom.toISOString().slice(0, 10))} → ${escape(s.dateRangeTo.toISOString().slice(0, 10))} ·
      Instruments: ${escape(s.instruments.join(", "))} ·
      Random seed: <code>${String(s.randomSeed)}</code>
    </p>
  </section>

  ${
    metrics === null
      ? ""
      : `<section class="card">
    <h2>Aggregate metrics</h2>
    <pre style="background: var(--bg-elev-2); padding: 12px; border-radius: 6px; overflow: auto; font-size: 12px;">${escape(JSON.stringify(metrics, null, 2))}</pre>
  </section>`
  }

  <section class="card">
    <h2>Trades (${opts.trades.length})</h2>
    ${
      opts.trades.length === 0
        ? `<p class="muted">No trades recorded.</p>`
        : `<table>
      <thead><tr>
        <th>Entry</th><th>Exit</th><th>Inst</th><th>Side</th>
        <th>Entry px</th><th>Exit px</th><th>Exit reason</th>
        <th>R</th><th>P&amp;L</th>
      </tr></thead>
      <tbody>
      ${opts.trades
        .map((t) => {
          const pnl = Number(t.realizedPnlUsd);
          const cls = pnl >= 0 ? "good" : "bad";
          return `
        <tr>
          <td class="muted num">${escape(t.entryTime.toISOString().slice(0, 16).replace("T", " "))}</td>
          <td class="muted num">${escape(t.exitTime.toISOString().slice(0, 16).replace("T", " "))}</td>
          <td>${escape(t.instrument)}</td>
          <td>${t.direction === "long" ? "L" : "S"}</td>
          <td class="num">${escape(t.entryPrice)}</td>
          <td class="num">${escape(t.exitPrice)}</td>
          <td class="muted">${escape(t.exitReason)}</td>
          <td class="num">${escape(t.realizedRMultiple)}</td>
          <td class="num ${cls}">$${escape(t.realizedPnlUsd)}</td>
        </tr>`;
        })
        .join("")}
      </tbody></table>`
    }
  </section>`;
}

// --------------------------------------------------------- Configuration

export function configPage(cfg: RiskConfig, lastChanged?: Date | null): string {
  const fields: Array<{ name: keyof RiskConfig; label: string }> = [
    { name: "riskPerTradePct", label: "Risk per trade (%)" },
    { name: "maxTotalOpenRiskPct", label: "Max total open risk (%)" },
    { name: "maxCorrelatedClusterPct", label: "Max correlated cluster (%)" },
    { name: "maxMarginUtilizationPct", label: "Max margin utilization (%)" },
    { name: "dailyLossLimitPct", label: "Daily loss limit (%)" },
    { name: "weeklySoftAlertPct", label: "Weekly soft alert (%)" },
    { name: "weeklyHardHaltPct", label: "Weekly hard halt (%)" },
    { name: "monthlySoftAlertPct", label: "Monthly soft alert (%)" },
    { name: "monthlyHardHaltPct", label: "Monthly hard halt (%)" },
    { name: "drawdownSoftReducePct", label: "Drawdown soft reduce (%)" },
    { name: "drawdownEmergencyStopPct", label: "Drawdown emergency stop (%)" },
    { name: "drawdownRebuildRequiredPct", label: "Drawdown rebuild required (%)" },
  ];
  return `
  <h1>Configuration</h1>
  <section class="card">
    ${lastChanged ? `<p class="muted">Last changed: ${escape(lastChanged.toISOString().replace("T", " ").slice(0, 19))}</p>` : ""}
    <form method="POST" action="/api/config" id="config-form"
          onsubmit="return confirm('Update risk configuration? Changes take effect immediately.')">
      <div class="grid-2">
        ${fields
          .map(
            (f) => `<div>
          <label>${f.label}</label>
          <input type="number" step="0.01" name="${f.name}" value="${cfg[f.name]}" style="width: 100%;" />
        </div>`,
          )
          .join("")}
      </div>
      <div style="margin-top: 16px;">
        <button class="accent" type="submit">Save</button>
      </div>
    </form>
  </section>`;
}

// ------------------------------------------------------- Manual orders

export function manualOrdersPage(opts: {
  positions: Position[];
  recentManualEvents: AuditEventRow[];
}): string {
  return `
  <h1>Manual orders</h1>

  <section class="card">
    <h2>Place a new order</h2>
    <form method="POST" action="/api/manual-order"
          onsubmit="return confirm('Submit manual order? Risk checks still apply.')">
      <div class="grid-3">
        <div>
          <label>Instrument</label>
          <input type="text" name="instrument" placeholder="EURUSD" required style="width:100%;" />
        </div>
        <div>
          <label>Direction</label>
          <select name="direction" required style="width:100%;">
            <option value="long">long</option>
            <option value="short">short</option>
          </select>
        </div>
        <div>
          <label>Order type</label>
          <select name="orderType" required style="width:100%;">
            <option value="market">market</option>
            <option value="limit">limit</option>
            <option value="stop">stop</option>
          </select>
        </div>
        <div>
          <label>Lot size</label>
          <input type="number" name="lotSize" step="0.01" min="0.01" required style="width:100%;" />
        </div>
        <div>
          <label>Stop price</label>
          <input type="number" name="stopPrice" step="0.000001" required style="width:100%;" />
        </div>
        <div>
          <label>Target price</label>
          <input type="number" name="targetPrice" step="0.000001" required style="width:100%;" />
        </div>
        <div>
          <label>Limit/stop price (if not market)</label>
          <input type="number" name="price" step="0.000001" style="width:100%;" />
        </div>
        <div style="grid-column: span 2;">
          <label>Reason</label>
          <input type="text" name="reason" placeholder="why this manual entry?" required style="width:100%;" />
        </div>
      </div>
      <div style="margin-top: 16px;">
        <button class="accent" type="submit">Submit</button>
      </div>
    </form>
  </section>

  ${opts.positions.length === 0 ? "" : `
  <section class="card">
    <h2>Current positions</h2>
    <table>
      <thead><tr><th>Instrument</th><th>Side</th><th>Lots</th><th>P&amp;L</th><th></th></tr></thead>
      <tbody>
      ${opts.positions
        .map(
          (p) => `<tr>
        <td>${escape(p.instrument)}</td>
        <td>${p.direction === "long" ? "LONG" : "SHORT"}</td>
        <td class="num">${fmtNum(p.lotSize, 2)}</td>
        <td class="num ${p.unrealizedPnLUsd >= 0 ? "good" : "bad"}">$${fmtNum(p.unrealizedPnLUsd, 2)}</td>
        <td>
          <form method="POST" action="/api/close-position" class="inline"
                onsubmit="return confirm('Close ${escape(p.instrument)}?')">
            <input type="hidden" name="positionId" value="${escape(p.id)}" />
            <button type="submit">Close</button>
          </form>
        </td>
      </tr>`,
        )
        .join("")}
      </tbody>
    </table>
  </section>`}

  <section class="card">
    <h2>Recent manual activity</h2>
    ${
      opts.recentManualEvents.length === 0
        ? `<p class="muted">No manual operations yet.</p>`
        : `<table>
      <thead><tr><th>When</th><th>Description</th></tr></thead>
      <tbody>
      ${opts.recentManualEvents
        .map(
          (e) => `<tr>
        <td class="muted num">${escape(e.createdAt.toISOString().replace("T", " ").slice(0, 19))}</td>
        <td>${escape(e.description)}</td>
      </tr>`,
        )
        .join("")}
      </tbody></table>`
    }
  </section>`;
}

function fmtNum(n: number, decimals: number): string {
  if (!Number.isFinite(n)) {return "—";}
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
