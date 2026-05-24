# `research/` — asset-specific strategy discovery + walk-forward validation

A self-contained Python harness that discovers, per crypto instrument, the
strategy that fits *that asset's* behaviour, and validates it with genuine
walk-forward out-of-sample testing. **Read [`FINDINGS.md`](./FINDINGS.md) for
the results and the headline numbers.**

## Why it lives outside the TypeScript bot
The production bot (`packages/bot`) is an intraday, session-based system that
streams hourly Binance candles into Postgres. This harness answers a different,
upstream question — *what is the right strategy and risk profile for each
asset?* — and must run fully offline (the sandbox blocks exchange APIs), so it
sources real daily prices from public Coin Metrics data on GitHub and keeps no
DB dependency. The validated answers are exported to
`results/strategy_configs.json` so they can feed the bot's config.

## Files
| File | Role |
| --- | --- |
| `data.py` | Fetch + cache real daily close prices (BTC/ETH/DOT/LINK/ADA/DOGE/XRP/LTC/BNB). |
| `engine.py` | Lookahead-free daily backtest engine + metrics + cost model. |
| `strategies.py` | Strategy families (momentum, breakout, regime-trend, mean-reversion) + vol-target overlay + parameter grids. |
| `walkforward.py` | Rolling train/test walk-forward; OOS stitching; pass gate. |
| `run_research.py` | Per-asset family sweep + ranking + portfolio. |
| `robustness.py` | Cost-sensitivity ladder + per-year OOS breakdown. |
| `portfolio_analysis.py` | Equal-weight portfolios + deployable config export. |
| `diag_dot.py` | One-off diagnostic of the hard DOT case. |
| `data/` | Cached slim `date,close` series (committed for offline reproducibility). |
| `results/` | Generated JSON + OOS equity CSVs. |

## Run
```bash
python3 -m venv research_venv && research_venv/bin/pip install numpy pandas
cd research
../research_venv/bin/python run_research.py --all
../research_venv/bin/python portfolio_analysis.py
```
