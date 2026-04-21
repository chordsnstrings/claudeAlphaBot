import { cn } from "@/lib/cn";
import { formatCrypto, formatUsd, formatUtc, signColor } from "@/lib/format";
import type { TradeRow } from "@/db/queries-ext";

/**
 * Full trades table (used on /trades). Shows every column; paired with
 * client-side filters on the parent page via URL searchParams so the
 * component itself stays a server component.
 */
export function FullTradesTable({ rows }: { readonly rows: readonly TradeRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="text-default text-text-tertiary py-10 text-center">
        No trades match the current filters.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-default">
        <thead className="sticky top-0 bg-bg-1 text-text-tertiary text-secondary">
          <tr className="border-b border-border-subtle">
            <th className="text-left py-2 px-3 font-medium font-mono">Exit</th>
            <th className="text-left py-2 px-3 font-medium">Mode</th>
            <th className="text-left py-2 px-3 font-medium">Symbol</th>
            <th className="text-left py-2 px-3 font-medium">Strategy</th>
            <th className="text-left py-2 px-3 font-medium">Dir</th>
            <th className="text-right py-2 px-3 font-medium font-mono">Entry</th>
            <th className="text-right py-2 px-3 font-medium font-mono">Exit $</th>
            <th className="text-right py-2 px-3 font-medium font-mono">Qty</th>
            <th className="text-right py-2 px-3 font-medium font-mono">PnL</th>
            <th className="text-right py-2 px-3 font-medium font-mono">R</th>
            <th className="text-left py-2 px-3 font-medium">Reason</th>
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
              <td className="py-2 px-3 font-mono text-table-dense">{r.mode}</td>
              <td className="py-2 px-3 font-mono">{r.symbol}</td>
              <td className="py-2 px-3 text-text-secondary">{r.strategy}</td>
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
              <td className="py-2 px-3 text-right font-mono">{formatUsd(r.entryPrice)}</td>
              <td className="py-2 px-3 text-right font-mono">{formatUsd(r.exitPrice)}</td>
              <td className="py-2 px-3 text-right font-mono text-text-tertiary">
                {formatCrypto(r.quantity)}
              </td>
              <td
                className={cn(
                  "py-2 px-3 text-right font-mono font-medium",
                  signColor(r.pnlUsd),
                )}
              >
                {formatUsd(r.pnlUsd)}
              </td>
              <td className={cn("py-2 px-3 text-right font-mono", signColor(r.pnlR))}>
                {r.pnlR.toFixed(2)}R
              </td>
              <td className="py-2 px-3 text-text-tertiary font-mono text-table-dense">
                {r.exitReason}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
