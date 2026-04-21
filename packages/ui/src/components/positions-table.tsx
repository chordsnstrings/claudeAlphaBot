import { cn } from "@/lib/cn";
import { formatCrypto, formatUsd, formatUtc } from "@/lib/format";
import type { OpenPositionRow } from "@/db/queries";

export function PositionsTable({ rows }: { readonly rows: readonly OpenPositionRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="text-default text-text-tertiary py-8 text-center">
        No open positions.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-default">
        <thead className="sticky top-0 bg-bg-1 text-text-tertiary text-secondary">
          <tr className="border-b border-border-subtle">
            <th className="text-left py-2 px-3 font-medium">Symbol</th>
            <th className="text-left py-2 px-3 font-medium">Dir</th>
            <th className="text-right py-2 px-3 font-medium font-mono">Entry</th>
            <th className="text-right py-2 px-3 font-medium font-mono">Qty</th>
            <th className="text-right py-2 px-3 font-medium font-mono">Stop</th>
            <th className="text-right py-2 px-3 font-medium font-mono">TP1</th>
            <th className="text-right py-2 px-3 font-medium font-mono">Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={r.id}
              className={cn(
                i % 2 === 0 ? "bg-bg-1" : "bg-bg-0",
                "hover:bg-bg-2 transition-colors duration-150 border-b border-border-subtle",
              )}
            >
              <td className="py-2 px-3 font-mono">{r.symbol}</td>
              <td className="py-2 px-3">
                <DirectionPill direction={r.direction} />
              </td>
              <td className="py-2 px-3 text-right font-mono">{formatUsd(r.entryPrice)}</td>
              <td className="py-2 px-3 text-right font-mono">{formatCrypto(r.quantity)}</td>
              <td className="py-2 px-3 text-right font-mono">{formatUsd(r.stopPrice)}</td>
              <td className="py-2 px-3 text-right font-mono">{formatUsd(r.tp1Price)}</td>
              <td className="py-2 px-3 text-right font-mono text-text-tertiary">
                {formatUtc(r.entryTime)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DirectionPill({ direction }: { readonly direction: "LONG" | "SHORT" }) {
  const isLong = direction === "LONG";
  return (
    <span
      className={cn(
        "inline-flex px-2 py-0.5 rounded-full font-mono text-table-dense font-semibold",
        isLong ? "bg-green-bg text-green" : "bg-red-bg text-red",
      )}
    >
      {direction}
    </span>
  );
}
