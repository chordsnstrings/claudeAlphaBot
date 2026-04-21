/**
 * Centralised number / time formatters so every table + card renders
 * the same way. The tests can pin a single helper instead of asserting
 * on ad-hoc `.toFixed()` calls sprinkled through components.
 */

export function formatUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

export function formatCrypto(n: number): string {
  return n.toFixed(8);
}

export function formatPct(n: number, signed = true): string {
  const sign = signed && n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

/** UTC, "YYYY-MM-DD HH:MM". Never relative. */
export function formatUtc(ms: number): string {
  const d = new Date(ms);
  const pad = (x: number) => String(x).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  );
}

/** "2h ago" / "3d ago" / "just now" — only for cards, not tables. */
export function relativeAgo(ms: number, nowMs: number = Date.now()): string {
  const diff = nowMs - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function signColor(n: number): string {
  return n > 0 ? "text-green" : n < 0 ? "text-red" : "text-text-secondary";
}
