# Dashboard — All-Weather Harvest bot

A minimal, dependency-free dashboard for the newest bot (unified momentum + crisis-alpha
+ 2× profit-harvest). Pure Python stdlib server + a self-contained SPA (no npm, no CDN,
no framework). Every number is produced by the **tested engine** (`unified_bot`,
`harvest_sweep`, `live_trader`, …), so the UI is faithful to the backtest.

## Run
```bash
cd research
python ui/server.py            # http://localhost:8000  (or: python ui/server.py 8080)
```
The server serves a precomputed snapshot (`ui/ui_data.json`). Click **Refresh** (or
`POST /api/refresh`) to regenerate it by re-running the engine (~1–2 min).

Regenerate the snapshot manually:
```bash
python ui/build_ui_data.py     # runs build_panel + the 600-config sweep + harvest curve + live fetch
```

## What it shows
- **Headline KPIs** — cash ROI (5.1×), cash extracted, max total-wealth drawdown, principal-return days.
- **Strategy book** — the four-sleeve capital split + the harvest rule chips.
- **Sleeve quality** — per-sleeve CAGR / Sharpe / maxDD (OOS, 1×).
- **Fidelity** — the parity status (live == tested) per sleeve.
- **Harvest cash curve** — cumulative cash on the $300k base + per-year bars.
- **Sweep frontier** — the 597 self-funding configs (ROI vs drawdown), recommended highlighted.
- **Live target book** — current per-coin weights/notionals, gross/net, harvest state.
- **Market** — BTC/ETH/SOL/DOGE/XRP price + trend vs SMA50/200.

## Files
- `server.py` — stdlib HTTP server + `/api/data`, `/api/refresh`, `/api/status`.
- `build_ui_data.py` — runs the engine once → `ui_data.json`.
- `static/{index.html,style.css,app.js}` — the SPA (SVG charts, no deps).
- `ui_data.json` — committed snapshot so the dashboard works out-of-the-box.

Backtest / OOS figures — not financial advice; leverage is ruinous if mis-sized.
