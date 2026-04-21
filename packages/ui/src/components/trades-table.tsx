import { cn } from "@/lib/cn";
import { formatUsd, formatUtc, signColor } from "@/lib/format";
import type { RecentTradeRow } from "@/db/queries";

export function TradesTable({
  rows,
  showStrategy = true,
}: {
  readonly rows: readonly RecentTradeRow[];
  readonly showStrategy?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <div className="text-default text-text-tertiary py-8 text-center">
        No trades yet.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-default">
        <thead className="sticky top-0 bg-bg-1 text-text-tertiary text-secondary">
          <tr className="border-b border-border-subtle">
            <th className="text-left py-2 px-3 font-medium font-mono">Time</th>
            <th className="text-left py-2 px-3 font-medium">Symbol</th>
            {showStrategy ? (
              <th className="text-left py-2 px-3 font-medium">Strategy</th>
            ) : null}
            <th className="text-left py-2 px-3 font-medium">Dir</th>
            <th className="text-left py-2 px-3 font-medium">Reason</th>
            <th className="text-right py-2 px-3 font-medium font-mono">PnL</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={r.tradeId}
              className={cn(
                i % 2 === 0 ? "bg-bg-1" : "bg-bg-0",
                "hover:bg-bg-2 transition-colors duration-150 border-b border-border-subtle",
              )}
            >
              <td className="py-2 px-3 font-mono text-text-tertiary">
                {formatUtc(r.exitTimeUtc)}
              </td>
              <td className="py-2 px-3 font-mono">{r.symbol}</td>
              {showStrategy ? (
                <td className="py-2 px-3 text-text-secondary">{r.strategy}</td>
              ) : null}
              <td className="py-2 px-3">
                <span
                  className={cn(
                    "font-mono text-table-dense font-semibold",
                    r.direction === "LONG" ? "text-green" : "text-red",
                  )}
                >
                  {r.direction}
                </span>
              </td>
              <td className="py-2 px-3 text-text-tertiary font-mono text-table-dense">
                {r.exitReason}
              </td>
              <td
                className={cn(
                  "py-2 px-3 text-right font-mono font-medium",
                  signColor(r.pnlUsd),
                )}
              >
                {formatUsd(r.pnlUsd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
