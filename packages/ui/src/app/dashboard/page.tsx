import { Card } from "@/components/card";
import { EquityChart } from "@/components/equity-chart";
import { KpiCard } from "@/components/kpi-card";
import { PageTitle } from "@/components/page-title";
import { PositionsTable } from "@/components/positions-table";
import { RegimeCard } from "@/components/regime-card";
import { TopBar } from "@/components/top-bar";
import { TradesTable } from "@/components/trades-table";
import {
  loadEquityCurve,
  loadKpis,
  loadOpenPositions,
  loadRecentTrades,
  loadRegimeStatus,
  loadStatus,
} from "@/db/queries";
import { formatPct, formatUsd } from "@/lib/format";

/** Phase 16 — server-rendered dashboard. Revalidates every 30s. */
export const revalidate = 30;

export default async function DashboardPage() {
  const startingEquityUsd = Number(process.env["STARTING_EQUITY_USD"] ?? 5000);
  const [kpis, equity, positions, trades, regimeStatus, status] = await Promise.all([
    loadKpis(startingEquityUsd),
    loadEquityCurve(30),
    loadOpenPositions(),
    loadRecentTrades(10),
    loadRegimeStatus(),
    loadStatus(),
  ]);
  const uptimeMs = Date.now() - status.bootTimeMs;

  return (
    <div className="min-h-screen">
      <TopBar
        mode={status.mode}
        uptimeMs={uptimeMs}
        lastRegimeCheckIso={status.lastRegimeCheckIso}
      />
      <div className="px-6 py-4 md:px-8 md:py-6">
        <PageTitle
          title="Dashboard"
          subtitle="Overview of bot state, positions, and performance."
        />

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <KpiCard
            index={0}
            label="Equity"
            value={formatUsd(kpis.equityUsd)}
            delta={formatPct(kpis.allTimePct)}
            deltaNumeric={kpis.allTimePct}
            subtext="all-time"
            href="/performance"
          />
          <KpiCard
            index={1}
            label="Today"
            value={formatPct(kpis.todayPct)}
            deltaNumeric={kpis.todayPct}
            subtext={`${kpis.todayTrades} trades`}
          />
          <KpiCard
            index={2}
            label="Week"
            value={formatPct(kpis.weekPct)}
            deltaNumeric={kpis.weekPct}
            subtext={`${kpis.weekWins} wins`}
            href="/performance"
          />
          <KpiCard
            index={3}
            label="Win Rate"
            value={`${kpis.winRatePct.toFixed(0)}%`}
            subtext="all-time"
            href="/trades"
          />
        </div>

        <Card padding="lg" className="mb-6 animate-fade-up">
          <div className="flex items-center justify-between mb-4">
            <div className="text-subhead font-medium text-text-primary">Equity — last 30 days</div>
            <div className="text-secondary text-text-tertiary font-mono">
              {equity.length} points
            </div>
          </div>
          <EquityChart data={equity} />
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          <Card padding="md" className="animate-fade-up">
            <div className="flex items-center justify-between mb-3 px-3">
              <div className="text-subhead font-medium text-text-primary">
                Open Positions
              </div>
              <div className="text-secondary text-text-tertiary font-mono">
                {positions.length}
              </div>
            </div>
            <PositionsTable rows={positions} />
          </Card>
          <Card padding="md" className="animate-fade-up">
            <div className="flex items-center justify-between mb-3 px-3">
              <div className="text-subhead font-medium text-text-primary">
                Recent Trades
              </div>
              <a
                href="/trades"
                className="text-secondary text-accent hover:text-accent-hover transition-colors duration-150"
              >
                View all →
              </a>
            </div>
            <TradesTable rows={trades} />
          </Card>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {regimeStatus.map((r) => (
            <RegimeCard key={r.symbol} status={r} />
          ))}
        </div>
      </div>
    </div>
  );
}
