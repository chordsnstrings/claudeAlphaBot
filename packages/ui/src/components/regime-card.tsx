import { cn } from "@/lib/cn";
import { formatUtc } from "@/lib/format";
import type { RegimeStatus } from "@/db/queries";
import { Card } from "./card";

/**
 * One card per symbol: current regime, confidence bar, last check time,
 * colour-coded dot: green=UNCHANGED, orange=DRIFTED, red=FLIPPED.
 */
export function RegimeCard({ status }: { readonly status: RegimeStatus }) {
  const dotColor =
    status.outcome === "UNCHANGED"
      ? "bg-green"
      : status.outcome === "DRIFTED"
        ? "bg-orange"
        : status.outcome === "FLIPPED"
          ? "bg-red"
          : "bg-border-default";

  return (
    <Card padding="md">
      <div className="flex items-center justify-between mb-3">
        <div className="font-mono font-medium text-text-primary">{status.symbol}</div>
        <span
          className={cn("w-2 h-2 rounded-full", dotColor)}
          aria-label={status.outcome ?? "no check yet"}
        />
      </div>
      <div className="text-secondary text-text-tertiary mb-1">Regime</div>
      <div className="text-default text-text-primary font-medium mb-3">
        {status.currentRegime}
      </div>
      {status.confidence !== null ? (
        <>
          <div className="text-secondary text-text-tertiary mb-1">
            Confidence {status.confidence.toFixed(1)}%
          </div>
          <div className="w-full h-1.5 bg-bg-2 rounded-full overflow-hidden mb-3">
            <div
              className="h-full bg-accent transition-all duration-200"
              style={{ width: `${Math.max(0, Math.min(100, status.confidence))}%` }}
            />
          </div>
        </>
      ) : null}
      <div className="text-table-dense text-text-tertiary font-mono">
        {status.lastCheckUtc ? `Last check ${formatUtc(status.lastCheckUtc)} UTC` : "No check yet"}
      </div>
    </Card>
  );
}
