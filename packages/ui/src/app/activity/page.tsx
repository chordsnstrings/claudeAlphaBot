import { Card } from "@/components/card";
import { PageShell } from "@/components/page-shell";
import { loadActivityFeed } from "@/db/queries-ext";
import { formatUtc, relativeAgo } from "@/lib/format";
import { cn } from "@/lib/cn";

export const revalidate = 15;

export default async function ActivityPage() {
  const events = await loadActivityFeed(100);
  return (
    <PageShell
      title="Live Activity"
      subtitle="Streaming feed of recent bot events — regime checks, trades, breakers."
    >
      <Card padding="md" className="animate-fade-up">
        {events.length === 0 ? (
          <div className="text-default text-text-tertiary py-10 text-center">
            No activity yet. The feed populates once the bot starts writing events.
          </div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {events.map((e, i) => (
              <li
                key={`${e.timestampUtc}-${i}`}
                className="flex items-start gap-3 py-2 px-3 hover:bg-bg-2 transition-colors duration-150"
              >
                <span className={cn("mt-1.5 w-1.5 h-1.5 rounded-full shrink-0", dotColor(e.kind))} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-table-dense font-medium text-text-primary">
                      {e.kind}
                    </span>
                    {e.symbol ? (
                      <span className="font-mono text-table-dense text-text-secondary">
                        {e.symbol}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-secondary text-text-tertiary truncate">{e.detail}</div>
                </div>
                <div className="text-secondary text-text-tertiary font-mono whitespace-nowrap">
                  {formatUtc(e.timestampUtc)} · {relativeAgo(e.timestampUtc)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </PageShell>
  );
}

function dotColor(kind: string): string {
  if (kind.startsWith("BREAKER")) return "bg-red";
  if (kind.startsWith("REGIME_FLIPPED")) return "bg-red";
  if (kind.startsWith("REGIME_DRIFTED")) return "bg-orange";
  if (kind.startsWith("REGIME_UNCHANGED")) return "bg-green";
  if (kind === "REVALIDATION") return "bg-accent";
  if (kind.startsWith("TRADE_")) return "bg-text-secondary";
  if (kind === "POSITION_OPENED") return "bg-accent";
  return "bg-border-default";
}
