import { ModePill } from "./mode-pill";

export interface TopBarProps {
  readonly mode: string;
  readonly uptimeMs: number;
  readonly lastRegimeCheckIso: string | null;
}

/**
 * Thin header at the top of every page: mode pill, uptime, last regime
 * check. Not sticky — uses the same 0-height-collapse layout pattern as
 * the sidebar so mobile stays clean.
 */
export function TopBar({ mode, uptimeMs, lastRegimeCheckIso }: TopBarProps) {
  return (
    <header className="flex items-center justify-between px-6 py-3 border-b border-border-subtle">
      <div className="flex items-center gap-4 pl-10 md:pl-0">
        <ModePill mode={mode} />
        <span className="hidden sm:inline text-secondary text-text-tertiary font-mono">
          Uptime {formatUptime(uptimeMs)}
        </span>
      </div>
      <div className="text-secondary text-text-tertiary font-mono">
        {lastRegimeCheckIso
          ? `Last check ${formatIsoCompact(lastRegimeCheckIso)} UTC`
          : "No regime check yet"}
      </div>
    </header>
  );
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatIsoCompact(iso: string): string {
  // "2026-04-21T14:23:45.000Z" → "2026-04-21 14:23"
  return iso.slice(0, 16).replace("T", " ");
}
