import { Card } from "@/components/card";
import { PageShell } from "@/components/page-shell";
import { RegimeCard } from "@/components/regime-card";
import { loadRegimeStatus } from "@/db/queries";
import { loadRegimeLog } from "@/db/queries-ext";
import { cn } from "@/lib/cn";
import { formatUtc } from "@/lib/format";

export const revalidate = 60;

export default async function RegimePage() {
  const [status, log] = await Promise.all([loadRegimeStatus(), loadRegimeLog(200)]);
  return (
    <PageShell
      title="Regime Monitor"
      subtitle="Current regime per symbol and the full daily-check log."
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {status.map((s) => (
          <RegimeCard key={s.symbol} status={s} />
        ))}
      </div>
      <Card padding="md" className="animate-fade-up">
        <div className="text-subhead font-medium text-text-primary mb-3 px-3">
          regime_check_log ({log.length})
        </div>
        {log.length === 0 ? (
          <div className="text-default text-text-tertiary py-10 text-center">
            No regime checks recorded yet. First check runs at 00:30 UTC.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-default">
              <thead className="sticky top-0 bg-bg-1 text-text-tertiary text-secondary">
                <tr className="border-b border-border-subtle">
                  <th className="text-left py-2 px-3 font-medium font-mono">Time</th>
                  <th className="text-left py-2 px-3 font-medium">Symbol</th>
                  <th className="text-left py-2 px-3 font-medium">Current</th>
                  <th className="text-left py-2 px-3 font-medium">Validation</th>
                  <th className="text-left py-2 px-3 font-medium">Outcome</th>
                  <th className="text-right py-2 px-3 font-medium font-mono">Δ Conf</th>
                </tr>
              </thead>
              <tbody>
                {log.map((r, i) => (
                  <tr
                    key={`${r.timestampUtc}-${r.symbol}`}
                    className={cn(
                      i % 2 === 0 ? "bg-bg-1" : "bg-bg-0",
                      "hover:bg-bg-2 transition-colors duration-150 border-b border-border-subtle",
                    )}
                  >
                    <td className="py-2 px-3 font-mono text-text-tertiary">
                      {formatUtc(r.timestampUtc)}
                    </td>
                    <td className="py-2 px-3 font-mono">{r.symbol}</td>
                    <td className="py-2 px-3">{r.currentRegime}</td>
                    <td className="py-2 px-3 text-text-secondary">{r.validationRegime}</td>
                    <td className="py-2 px-3">
                      <OutcomePill outcome={r.outcome} />
                    </td>
                    <td className="py-2 px-3 text-right font-mono">
                      {r.confidenceDeltaPct > 0 ? "+" : ""}
                      {r.confidenceDeltaPct.toFixed(2)}%
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

function OutcomePill({ outcome }: { readonly outcome: "UNCHANGED" | "DRIFTED" | "FLIPPED" }) {
  const styles =
    outcome === "UNCHANGED"
      ? "bg-green-bg text-green"
      : outcome === "DRIFTED"
        ? "bg-orange-bg text-orange"
        : "bg-red-bg text-red";
  return (
    <span
      className={cn(
        "inline-flex px-2 py-0.5 rounded-full font-mono text-table-dense font-semibold",
        styles,
      )}
    >
      {outcome}
    </span>
  );
}
