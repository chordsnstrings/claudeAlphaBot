import { cn } from "@/lib/cn";

export interface ModePillProps {
  readonly mode: string;
}

/**
 * Small rounded-full badge showing the bot mode. Colour-coded per spec:
 *   LIVE     → green
 *   PAPER    → blue
 *   BACKTEST → tertiary (gray)
 */
export function ModePill({ mode }: ModePillProps) {
  const upper = mode.toUpperCase();
  const classes =
    upper === "LIVE"
      ? "bg-green-bg text-green border-green/40"
      : upper === "PAPER"
        ? "bg-blue/10 text-blue border-blue/40"
        : "bg-bg-2 text-text-tertiary border-border-default";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5",
        "font-mono text-table-dense font-semibold tracking-wider",
        classes,
      )}
    >
      {upper}
    </span>
  );
}
