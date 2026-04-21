import { Card } from "@/components/card";
import { PageShell } from "@/components/page-shell";
import { loadBreakerEvents } from "@/db/queries-ext";
import { cn } from "@/lib/cn";
import { formatUsd, formatUtc } from "@/lib/format";

export const revalidate = 30;

export default async function BreakersPage() {
  const events = await loadBreakerEvents();
  const active = events.filter((e) => e.releasedAtUtc === null);
  return (
    <PageShell
      title="Circuit Breakers"
      subtitle="Current halts and full history of triggered breakers."
    >
      <Card padding="md" className="mb-6 animate-fade-up">
        <div className="flex items-center justify-between mb-2 px-3">
          <div className="text-subhead font-medium text-text-primary">Current state</div>
          <span
            className={cn(
              "font-mono text-table-dense font-semibold px-2 py-0.5 rounded-full",
              active.length === 0 ? "bg-green-bg text-green" : "bg-red-bg text-red",
            )}
          >
            {active.length === 0 ? "ALL CLEAR" : `${active.length} ACTIVE`}
          </span>
        </div>
        {active.length === 0 ? (
          <div className="text-default text-text-tertiary py-6 px-3">
            No active breakers. Trading proceeds normally.
          </div>
        ) : (
          <ul className="space-y-1 px-3">
            {active.map((e, i) => (
              <li
                key={`${e.timestampUtc}-${i}`}
                className="flex items-center justify-between text-default font-mono"
              >
                <span className="text-red">{e.kind}</span>
                <span className="text-text-tertiary">
                  {e.symbol ?? "ALL"} · triggered {formatUtc(e.timestampUtc)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card padding="md" className="animate-fade-up">
        <div className="text-subhead font-medium text-text-primary mb-3 px-3">
          History ({events.length})
        </div>
        {events.length === 0 ? (
          <div className="text-default text-text-tertiary py-10 text-center">
            No breaker events yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-default">
              <thead className="sticky top-0 bg-bg-1 text-text-tertiary text-secondary">
                <tr className="border-b border-border-subtle">
                  <th className="text-left py-2 px-3 font-medium font-mono">Triggered</th>
                  <th className="text-left py-2 px-3 font-medium">Kind</th>
                  <th className="text-left py-2 px-3 font-medium">Symbol</th>
                  <th className="text-right py-2 px-3 font-medium font-mono">Trigger PnL%</th>
                  <th className="text-right py-2 px-3 font-medium font-mono">Equity</th>
                  <th className="text-left py-2 px-3 font-medium">Action</th>
                  <th className="text-left py-2 px-3 font-medium font-mono">Released</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr
                    key={`${e.timestampUtc}-${i}`}
                    className={cn(
                      i % 2 === 0 ? "bg-bg-1" : "bg-bg-0",
                      "hover:bg-bg-2 transition-colors duration-150 border-b border-border-subtle",
                    )}
                  >
                    <td className="py-2 px-3 font-mono text-text-tertiary">
                      {formatUtc(e.timestampUtc)}
                    </td>
                    <td className="py-2 px-3 font-mono text-red">{e.kind}</td>
                    <td className="py-2 px-3 font-mono">{e.symbol ?? "ALL"}</td>
                    <td className="py-2 px-3 text-right font-mono">
                      {e.triggeredByPnlPct !== null
                        ? `${e.triggeredByPnlPct.toFixed(2)}%`
                        : "—"}
                    </td>
                    <td className="py-2 px-3 text-right font-mono">
                      {formatUsd(e.accountEquity)}
                    </td>
                    <td className="py-2 px-3 text-text-secondary text-table-dense font-mono">
                      {e.action}
                    </td>
                    <td className="py-2 px-3 font-mono text-text-tertiary">
                      {e.releasedAtUtc ? formatUtc(e.releasedAtUtc) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </PageShell>
  );
}
