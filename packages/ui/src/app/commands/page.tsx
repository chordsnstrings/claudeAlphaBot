import { Card } from "@/components/card";
import { CommandsPanel } from "@/components/commands-panel";
import { PageShell } from "@/components/page-shell";
import { loadArtifacts, loadCommandLog } from "@/db/queries-ext";
import { cn } from "@/lib/cn";
import { formatUtc } from "@/lib/format";

export const revalidate = 10;

export default async function CommandsPage() {
  const [artifacts, log] = await Promise.all([loadArtifacts(), loadCommandLog(50)]);
  const staged = artifacts.find((a) => a.deploymentAllowed && !a.isActive);
  return (
    <PageShell
      title="Commands"
      subtitle="Operator controls. Every button posts to the bot's rate-limited API (1 req / 10s)."
    >
      <div className="mb-6">
        <CommandsPanel artifactHash={staged?.artifactHash ?? null} />
      </div>

      <Card padding="md" className="animate-fade-up">
        <div className="text-subhead font-medium text-text-primary mb-3 px-3">
          Recent command log
        </div>
        {log.length === 0 ? (
          <div className="text-default text-text-tertiary py-6 text-center">
            No commands issued yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-default">
              <thead className="sticky top-0 bg-bg-1 text-text-tertiary text-secondary">
                <tr className="border-b border-border-subtle">
                  <th className="text-left py-2 px-3 font-medium font-mono">Time</th>
                  <th className="text-left py-2 px-3 font-medium">Command</th>
                  <th className="text-left py-2 px-3 font-medium">By</th>
                  <th className="text-left py-2 px-3 font-medium">Result</th>
                  <th className="text-left py-2 px-3 font-medium">Message</th>
                </tr>
              </thead>
              <tbody>
                {log.map((r, i) => (
                  <tr
                    key={`${r.timestampUtc}-${i}`}
                    className={cn(
                      i % 2 === 0 ? "bg-bg-1" : "bg-bg-0",
                      "hover:bg-bg-2 transition-colors duration-150 border-b border-border-subtle",
                    )}
                  >
                    <td className="py-2 px-3 font-mono text-text-tertiary">
                      {formatUtc(r.timestampUtc)}
                    </td>
                    <td className="py-2 px-3 font-mono text-text-primary">{r.command}</td>
                    <td className="py-2 px-3 text-text-secondary">{r.requester ?? "—"}</td>
                    <td className="py-2 px-3">
                      <ResultPill result={r.result} />
                    </td>
                    <td className="py-2 px-3 text-text-tertiary text-table-dense font-mono">
                      {r.errorMessage ?? ""}
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

function ResultPill({ result }: { readonly result: string }) {
  const cls =
    result === "OK"
      ? "bg-green-bg text-green"
      : result === "RATE_LIMITED"
        ? "bg-orange-bg text-orange"
        : "bg-red-bg text-red";
  return (
    <span
      className={cn(
        "inline-flex px-2 py-0.5 rounded-full font-mono text-table-dense font-semibold",
        cls,
      )}
    >
      {result}
    </span>
  );
}
