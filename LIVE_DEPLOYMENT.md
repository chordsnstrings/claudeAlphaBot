# Live Deployment & Runbook — Unified All-Weather Book + 2× Harvest

How to actually run the strategy. The deployable harness is
[`research/live_trader.py`](research/live_trader.py); the full engine spec + verbatim
code is in [`ENGINE_AND_HARVEST_REPLICATION.md`](ENGINE_AND_HARVEST_REPLICATION.md).

## What it deploys
- **Book (recommended all-weather profile):** CORE 40% (daily momentum, 5 coins) +
  BTC1H 15% + ETH8H 15% (intraday pullbacks) + SPINE 30% (long/short trend), at
  **leverage m=2** on a **$300,000 base**.
- **Harvest policy:** base resets each Jan (no compounding); when equity 2×'s, withdraw
  **50%** of the profit and keep trading (leave 50% on the table); year-end sweep;
  **−40% YTD stop** → flat for the rest of the year. **Self-funding:** losing-year
  top-ups come only from already-harvested cash (`cum_cash`), never new money.

## Commands
```bash
cd research
python live_trader.py init --capital 300000     # create a PAPER account at the base
python live_trader.py run                        # one daily cycle (refresh → mark → harvest → rebalance)
python live_trader.py status                     # current state + today's target book
python live_trader.py backtest --capital 300000  # full-history paper run of this exact live logic
```
State persists to `research/live_trader_state.json` (idempotent: one cycle per UTC day).

## Daily operating procedure
1. **Schedule `run` once per day, shortly after 00:00 UTC** (cron/systemd-timer). It
   refreshes data from the public Binance mirror, marks the book to yesterday's close,
   applies the harvest/risk state machine, and prints the new target book.
2. **Read the target book** = per-coin `weight` and `notional` (= weight × equity).
   `gross` and `net` summarise exposure; in a locked/flat state the book is cash.
3. **Reconcile** broker positions against the printed targets within the `rebal_band`
   (0.5% of equity) — only trade a coin if the gap exceeds the band (suppresses churn).
4. **Watch the events line**: `2x HARVEST` (cash withdrawn), `STOP` (flat for the year),
   `PRINCIPAL FULLY RETURNED`, `year-end` settle.

## Paper burn-in → go-live checklist
- [ ] Run `backtest` and confirm it reproduces the documented harvest numbers
      (~5× cash on $300k over the sample, self-funding, principal returned fast).
- [ ] Paper-trade (`init --mode paper`, daily `run`) for **≥ 1 quarter**; verify the
      paper equity/withdrawals track a reference backtest on the same dates.
- [ ] Exercise every risk path in paper: a 2× harvest, the −40% stop, a year-end reset.
- [ ] **Implement `LiveBroker.mark`** (the marked SEAM in `live_trader.py`): read account
      equity + positions from your exchange; for each coin compute
      `target_notional = equity × leverage × book_weight`; submit reduce/extend
      **post-only limit** orders to reach it within the rebalance band; set isolated-margin
      leverage; reconcile fills; persist. **It deliberately places no real orders until you do.**
- [ ] `init --mode live`, fund the **$300k base once**, start at **reduced size**, scale
      only after live fills track paper.
- [ ] Confirm the **self-funding** invariant holds live: never wire in more than the
      initial base; cover losing-year resets from withdrawn `cum_cash`.

## Risk controls (mandatory)
- **−40% annual stop** (flat for the rest of the calendar year if YTD ≤ −40% of base).
- **Leverage cap:** keep `m ≤ 3`; a single ≈ −33%/m intraday gap is ruin. At m=2 size so
  a plausible adverse day cannot liquidate. The −40% daily-model stop does **not** protect
  against an overnight gap — use exchange stop/liquidation buffers.
- **Data-integrity halt:** if the refresh is stale/gappy or a price looks implausible,
  do **not** trade; hold prior weights and alert.
- **Kill switch:** a manual flag that flattens the book and halts new orders.

## Honest gaps that remain in v1 (and how to close them)
- **Intraday sleeves run on the daily clock.** BTC1H/ETH8H triggers are evaluated at the
  daily bar; a faithful build runs an **hourly** loop that manages each sleeve's intrabar
  bracket (±3% / ATR 2:1 / time-stop). The daily approximation under-represents their
  edge — treat the 30% intraday allocation as provisional until the hourly runner exists.
- **Live spine universe ≠ backtest universe.** The backtest used a survivorship-free
  top-30 (incl. delisted corpses) to avoid bias; live trades a fixed set of
  currently-listed liquid USDT pairs (`CFG["spine_pairs"]`). Keep it to genuinely liquid
  names and modest size (the spine is cost-sensitive: fine ≤20 bps, gone at 50 bps).
- **No real OMS yet** — `LiveBroker` is a stub; paper is fully functional.
- **Capacity is finite** and **past performance is not predictive.** Paper first.
