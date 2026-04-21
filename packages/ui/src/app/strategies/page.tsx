import { Card } from "@/components/card";
import { PageShell } from "@/components/page-shell";
import { loadAllTrades, loadStrategyBreakdown } from "@/db/queries-ext";
import { formatPct, formatUsd, signColor } from "@/lib/format";
import { cn } from "@/lib/cn";

export const revalidate = 60;

const ALL_STRATEGIES = ["ARB", "NY_OPEN", "WEEKEND_MR", "FUNDING_FADE", "BB_MR"] as const;

export default async function StrategiesPage() {
  const [breakdown, trades] = await Promise.all([
    loadStrategyBreakdown(),
    loadAllTrades(500),
  ]);
  // Merge breakdown with an always-present row per strategy so the UI
  // shows strategies that haven't traded yet too.
  const byStrategy = new Map(breakdown.map((b) => [b.strategy, b]));

  return (
    <PageShell
      title="Strategies"
      subtitle="Per-strategy summary cards with expectancy, win rate, and recent trades."
    >
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {ALL_STRATEGIES.map((s) => {
          const b = byStrategy.get(s);
          const stratTrades = trades.filter((t) => t.strategy === s).slice(0, 5);
          return (
            <Card key={s} padding="md" className="animate-fade-up">
              <div className="flex items-center justify-between mb-3 px-3">
                <div className="text-subhead font-medium text-text-primary font-mono">{s}</div>
                <span
                  className={cn(
                    "text-secondary font-mono",
                    b ? signColor(b.totalPnlUsd) : "text-text-tertiary",
                  )}
                >
                  {b ? formatUsd(b.totalPnlUsd) : "—"}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-3 px-3 mb-3">
                <Stat label="Trades" value={b ? b.trades.toString() : "0"} />
                <Stat
                  label="Win Rate"
                  value={
                    b && b.trades > 0
                      ? formatPct((b.wins / b.trades) * 100, false)
                      : "—"
                  }
                />
                <Stat
                  label="Avg R"
                  value={b ? `${b.avgR.toFixed(2)}R` : "—"}
                  {...(b ? { valueClassName: signColor(b.avgR) } : {})}
                />
                <Stat
                  label="Expectancy"
                  value={
                    b && b.trades > 0
                      ? formatUsd(b.totalPnlUsd / b.trades)
                      : "—"
                  }
                  {...(b ? { valueClassName: signColor(b.totalPnlUsd) } : {})}
                />
              </dl>
              <div className="border-t border-border-subtle pt-3 mt-2">
                <div className="text-secondary text-text-tertiary px-3 mb-2">
                  Recent trades
                </div>
                {stratTrades.length === 0 ? (
                  <div className="text-default text-text-tertiary px-3 py-3 text-center">
                    No trades yet.
                  </div>
                ) : (
                  <ul className="space-y-1 px-3">
                    {stratTrades.map((t) => (
                      <li
                        key={t.tradeId}
                        className="flex items-center justify-between text-default font-mono"
                      >
                        <span className="text-text-secondary">{t.symbol}</span>
                        <span className={signColor(t.pnlUsd)}>{formatUsd(t.pnlUsd)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </PageShell>
  );
}

function Stat({
  label,
  value,
  valueClassName,
}: {
  readonly label: string;
  readonly value: string;
  readonly valueClassName?: string;
}) {
  return (
    <div>
      <dt className="text-secondary text-text-tertiary">{label}</dt>
      <dd className={cn("text-default font-mono font-medium", valueClassName)}>{value}</dd>
    </div>
  );
}
