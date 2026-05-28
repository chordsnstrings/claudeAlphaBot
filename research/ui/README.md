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
- `server.py` — stdlib HTTP server + `/health`, `/api/data`, `/api/refresh`, `/api/status`; basic-auth, security headers, optional self-refresh.
- `build_ui_data.py` — runs the engine once → `ui_data.json`.
- `static/{index.html,style.css,app.js}` — the SPA (SVG charts, no deps).
- `ui_data.json` — committed snapshot so the dashboard works out-of-the-box.
- `Dockerfile` + `requirements.txt` — container build (non-root, healthcheck).

## Deploy (DigitalOcean App Platform)
Self-contained web service — **no database, and no `ccxt` in the image, so it cannot place orders.**
```bash
# one-time: set the credentials, then create the app
doctl apps create --spec .do/harvest-dashboard.yaml
# in the DO UI (or via spec), set SECRETs:  DASHBOARD_USER, DASHBOARD_PASS
```
- The service builds `research/ui/Dockerfile`, serves on `$PORT`, health-checks `/health`.
- `REFRESH_HOURS=12` makes it re-run the engine and refresh the snapshot twice a day.
- **Set `DASHBOARD_USER`/`DASHBOARD_PASS`** or the dashboard runs open.

### Any container host
```bash
docker build -f research/ui/Dockerfile -t harvest-dash .
docker run -p 8080:8080 -e DASHBOARD_USER=you -e DASHBOARD_PASS=secret harvest-dash
```

> Live **trading** is deliberately NOT this service. It is a separate operator CLI
> (`research/live_trader.py --execute`, needs `pip install ccxt`) — run it on a private
> worker, never the public dashboard. And don't go live until the engine reconciliation
> (Python vs TS) and a testnet execution check are done.

Backtest / OOS figures — not financial advice; leverage is ruinous if mis-sized.
