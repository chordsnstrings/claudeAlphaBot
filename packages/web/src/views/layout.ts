/**
 * Server-rendered HTML layout. Linear/Vercel/Stripe aesthetic from
 * spec §12.1: dark mode default, sans-serif (Inter), generous
 * whitespace, restricted palette + single accent (indigo), no
 * marketing fluff. Designed to work without a JS bundle; SSE handles
 * live updates inline.
 */

export interface LayoutOpts {
  title: string;
  body: string;
  /** Currently-signed-in user; null on the login page. */
  user?: { name: string; role: "admin" | "operator" } | null;
  /** Account-type badge in the header: 'DEMO' | 'LIVE' | 'BACKTEST'. */
  modeBadge?: "DEMO" | "LIVE" | "BACKTEST" | null;
  /** Inline page-specific scripts. */
  scripts?: string;
}

export function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
:root {
  color-scheme: dark light;
  --bg: #0b0c0f;
  --bg-elev: #14161a;
  --bg-elev-2: #1c1f25;
  --fg: #e6e7eb;
  --fg-muted: #8a8f9a;
  --border: #232730;
  --accent: #7c83ff;
  --good: #4ade80;
  --bad: #f87171;
  --warn: #fbbf24;
  --font: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--font); font-size: 14px; line-height: 1.5; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
header.nav { display: flex; align-items: center; gap: 24px; padding: 12px 24px; background: var(--bg-elev); border-bottom: 1px solid var(--border); }
header.nav .brand { font-weight: 600; letter-spacing: 0.02em; }
header.nav nav { display: flex; gap: 16px; flex: 1; }
header.nav nav a { color: var(--fg-muted); }
header.nav nav a.active, header.nav nav a:hover { color: var(--fg); }
header.nav .badge { padding: 2px 10px; border-radius: 9999px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; }
header.nav .badge.demo { background: #1f3a5f; color: #93c5fd; }
header.nav .badge.live { background: #4a1e1e; color: #fca5a5; }
header.nav .badge.backtest { background: #2d2640; color: #c4b5fd; }
header.nav form.estop { margin: 0; }
header.nav button.estop {
  background: #7f1d1d; color: #fff; border: 1px solid #b91c1c;
  padding: 8px 14px; font-weight: 600; border-radius: 8px; cursor: pointer;
}
header.nav button.estop:hover { background: #991b1b; }
main { padding: 24px; max-width: 1280px; margin: 0 auto; }
h1 { font-size: 22px; font-weight: 600; margin: 0 0 16px 0; }
h2 { font-size: 16px; font-weight: 600; margin: 24px 0 8px 0; color: var(--fg); }
section.card { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
th { color: var(--fg-muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
tr:last-child td { border-bottom: 0; }
.num { font-variant-numeric: tabular-nums; }
.good { color: var(--good); }
.bad { color: var(--bad); }
.muted { color: var(--fg-muted); }
form.inline { display: inline-flex; gap: 4px; margin: 0; }
button, input[type=submit] {
  background: var(--bg-elev-2); color: var(--fg); border: 1px solid var(--border);
  padding: 6px 12px; border-radius: 6px; cursor: pointer; font-family: var(--font); font-size: 13px;
}
button:hover { background: #262a32; }
button.accent { background: var(--accent); border-color: var(--accent); color: #0b0c0f; font-weight: 600; }
input[type=text], input[type=number], input[type=password], select {
  background: var(--bg-elev-2); color: var(--fg); border: 1px solid var(--border);
  padding: 8px 12px; border-radius: 6px; font-family: var(--font); font-size: 13px;
}
label { display: block; margin-bottom: 4px; color: var(--fg-muted); font-size: 12px; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
.stat { font-size: 24px; font-weight: 600; }
.stat-label { font-size: 11px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.05em; }
`.trim();

function badgeHtml(modeBadge: LayoutOpts["modeBadge"]): string {
  if (modeBadge === null || modeBadge === undefined) {
    return "";
  }
  const cls = modeBadge.toLowerCase();
  return `<span class="badge ${cls}">${modeBadge}</span>`;
}

export function layout(opts: LayoutOpts): string {
  const navHtml =
    opts.user === null || opts.user === undefined
      ? ""
      : `
    <nav>
      <a href="/dashboard">Dashboard</a>
      <a href="/backtests">Backtests</a>
      <a href="/sessions">Live sessions</a>
      <a href="/config">Configuration</a>
      <a href="/orders">Manual orders</a>
    </nav>
    ${badgeHtml(opts.modeBadge ?? null)}
    <span class="muted">${escape(opts.user.name)}</span>
    <form method="POST" action="/api/emergency-stop" class="estop"
          onsubmit="return confirm('EMERGENCY STOP: cancel all orders and close all positions. Are you sure?')">
      <button class="estop" type="submit">Emergency stop</button>
    </form>
    <form method="POST" action="/logout" class="inline">
      <button type="submit">Sign out</button>
    </form>
  `;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escape(opts.title)} · Trading System</title>
  <style>${CSS}</style>
</head>
<body>
  <header class="nav">
    <div class="brand">trading.</div>
    ${navHtml}
  </header>
  <main>${opts.body}</main>
  ${opts.scripts ?? ""}
</body>
</html>`;
}
