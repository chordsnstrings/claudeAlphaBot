import { Card } from "@/components/card";
import { EquityChart } from "@/components/equity-chart";
import { PageShell } from "@/components/page-shell";
import { loadEquityCurve } from "@/db/queries";
import { loadPerformance, loadStrategyBreakdown } from "@/db/queries-ext";
import { formatPct, formatUsd, signColor } from "@/lib/format";
import { cn } from "@/lib/cn";

export const revalidate = 30;

const RANGES = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "365d": 365,
} as const;

type RangeKey = keyof typeof RANGES;

export default async function PerformancePage({
  searchParams,
}: {
  readonly searchParams?: Record<string, string | string[] | undefined>;
}) {
  const rawRange = Array.isArray(searchParams?.["range"])
    ? searchParams?.["range"]?.[0]
    : searchParams?.["range"];
  const rangeKey: RangeKey = rawRange && rawRange in RANGES ? (rawRange as RangeKey) : "30d";
  const days = RANGES[rangeKey];
  const now = Date.now();
  const from = now - days * 86_400_000;

  const [perf, equity, strategies] = await Promise.all([
    loadPerformance(from, now),
    loadEquityCurve(days),
    loadStrategyBreakdown(),
  ]);

  return (
    <PageShell
      title="Performance"
      subtitle="Equity curve, summary metrics, per-strategy breakdown."
    >
      <div className="mb-4 flex items-center gap-2">
        {(Object.keys(RANGES) as readonly RangeKey[]).map((k) => (
          <a
            key={k}
            href={`/performance?range=${k}`}
            className={cn(
              "rounded-md px-3 py-1.5 text-default font-mono transition-colors duration-150",
              k === rangeKey
                ? "bg-accent text-bg-0 font-medium"
                : "bg-bg-1 text-text-secondary hover:bg-bg-2",
            )}
          >
            {k}
          </a>
        ))}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <MetricCard label="Trades" value={perf.totalTrades.toString()} />
        <MetricCard label="Win Rate" value={`${perf.winRatePct.toFixed(1)}%`} />
        <MetricCard
          label="Total PnL"
          value={formatUsd(perf.totalPnlUsd)}
          valueClassName={signColor(perf.totalPnlUsd)}
        />
        <MetricCard
          label="Profit Factor"
          value={Number.isFinite(perf.profitFactor) ? perf.profitFactor.toFixed(2) : "∞"}
        />
        <MetricCard
          label="Avg R / Trade"
          value={`${perf.avgRPerTrade.toFixed(2)}R`}
          valueClassName={signColor(perf.avgRPerTrade)}
        />
        <MetricCard
          label="Best R"
          value={`${perf.bestRMultiple.toFixed(2)}R`}
          valueClassName="text-green"
        />
        <MetricCard
          label="Worst R"
          value={`${perf.worstRMultiple.toFixed(2)}R`}
          valueClassName="text-red"
        />
        <MetricCard label="Window" value={rangeKey} valueClassName="text-text-secondary" />
      </div>

      <Card padding="lg" className="mb-6 animate-fade-up">
        <div className="flex items-center justify-between mb-4">
          <div className="text-subhead font-medium text-text-primary">
            Equity — last {rangeKey}
          </div>
          <div className="text-secondary text-text-tertiary font-mono">
            {equity.length} points
          </div>
        </div>
        <EquityChart data={equity} />
      </Card>

      <Card padding="md" className="animate-fade-up">
        <div className="text-subhead font-medium text-text-primary mb-3 px-3">
          Per-strategy breakdown
        </div>
        <StrategyTable rows={strategies} />
      </Card>
    </PageShell>
  );
}

function MetricCard({
  label,
  value,
  valueClassName,
}: {
  readonly label: string;
  readonly value: string;
  readonly valueClassName?: string;
}) {
  return (
    <Card padding="sm" className="animate-fade-up">
      <div className="text-secondary text-text-tertiary mb-1">{label}</div>
      <div className={cn("text-subhead font-mono font-semibold", valueClassName)}>{value}</div>
    </Card>
  );
}

function StrategyTable({
  rows,
}: {
  readonly rows: readonly {
    strategy: string;
    trades: number;
    wins: number;
    totalPnlUsd: number;
    avgR: number;
  }[];
}) {
  if (rows.length === 0) {
    return (
      <div className="text-default text-text-tertiary py-8 text-center">
        No trades recorded yet.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-default">
        <thead className="text-text-tertiary text-secondary">
          <tr className="border-b border-border-subtle">
            <th className="text-left py-2 px-3 font-medium">Strategy</th>
            <th className="text-right py-2 px-3 font-medium font-mono">Trades</th>
            <th className="text-right py-2 px-3 font-medium font-mono">Win%</th>
            <th className="text-right py-2 px-3 font-medium font-mono">Total PnL</th>
            <th className="text-right py-2 px-3 font-medium font-mono">Avg R</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const winRate = r.trades === 0 ? 0 : (r.wins / r.trades) * 100;
            return (
              <tr
                key={r.strategy}
                className={cn(
                  i % 2 === 0 ? "bg-bg-1" : "bg-bg-0",
                  "hover:bg-bg-2 transition-colors duration-150 border-b border-border-subtle",
                )}
              >
                <td className="py-2 px-3 text-text-primary">{r.strategy}</td>
                <td className="py-2 px-3 text-right font-mono">{r.trades}</td>
                <td className="py-2 px-3 text-right font-mono">{formatPct(winRate, false)}</td>
                <td
                  className={cn(
                    "py-2 px-3 text-right font-mono font-medium",
                    signColor(r.totalPnlUsd),
                  )}
                >
                  {formatUsd(r.totalPnlUsd)}
                </td>
                <td className={cn("py-2 px-3 text-right font-mono", signColor(r.avgR))}>
                  {r.avgR.toFixed(2)}R
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
