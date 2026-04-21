import { Card } from "@/components/card";
import { PageShell } from "@/components/page-shell";
import { loadArtifacts } from "@/db/queries-ext";
import { cn } from "@/lib/cn";
import { formatUtc } from "@/lib/format";

export const revalidate = 60;

export default async function ValidationPage() {
  const artifacts = await loadArtifacts();
  return (
    <PageShell
      title="Validation"
      subtitle="Validated parameter artifacts — composite score, deployment eligibility, active flag."
    >
      <Card padding="md" className="animate-fade-up">
        {artifacts.length === 0 ? (
          <div className="text-default text-text-tertiary py-10 text-center">
            No validated artifacts yet. The first fortnightly run populates this table.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-default">
              <thead className="sticky top-0 bg-bg-1 text-text-tertiary text-secondary">
                <tr className="border-b border-border-subtle">
                  <th className="text-left py-2 px-3 font-medium font-mono">Created</th>
                  <th className="text-left py-2 px-3 font-medium font-mono">Artifact Hash</th>
                  <th className="text-left py-2 px-3 font-medium font-mono">Code Hash</th>
                  <th className="text-right py-2 px-3 font-medium font-mono">Score</th>
                  <th className="text-left py-2 px-3 font-medium">Deploy</th>
                  <th className="text-left py-2 px-3 font-medium">Active</th>
                </tr>
              </thead>
              <tbody>
                {artifacts.map((a, i) => (
                  <tr
                    key={a.artifactHash}
                    className={cn(
                      i % 2 === 0 ? "bg-bg-1" : "bg-bg-0",
                      "hover:bg-bg-2 transition-colors duration-150 border-b border-border-subtle",
                    )}
                  >
                    <td className="py-2 px-3 font-mono text-text-tertiary">
                      {formatUtc(a.createdAtUtc)}
                    </td>
                    <td className="py-2 px-3 font-mono text-table-dense text-text-primary">
                      {a.artifactHash.slice(0, 16)}…
                    </td>
                    <td className="py-2 px-3 font-mono text-table-dense text-text-tertiary">
                      {a.codeHash.slice(0, 12)}…
                    </td>
                    <td className="py-2 px-3 text-right font-mono font-medium">
                      {a.compositeScore.toFixed(4)}
                    </td>
                    <td className="py-2 px-3">
                      <Pill label={a.deploymentAllowed ? "ALLOWED" : "BLOCKED"} good={a.deploymentAllowed} />
                    </td>
                    <td className="py-2 px-3">
                      {a.isActive ? (
                        <Pill label="ACTIVE" good />
                      ) : (
                        <span className="text-text-tertiary font-mono text-table-dense">—</span>
                      )}
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

function Pill({ label, good }: { readonly label: string; readonly good: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex px-2 py-0.5 rounded-full font-mono text-table-dense font-semibold",
        good ? "bg-green-bg text-green" : "bg-red-bg text-red",
      )}
    >
      {label}
    </span>
  );
}
