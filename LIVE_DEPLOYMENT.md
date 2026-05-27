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
# --- going straight to live (no strategy paper-trading, per request) ---
python live_trader.py init --capital 300000 --mode live   # live account at the base
python live_trader.py run                                 # DRY-RUN: prints the exact orders, sends NOTHING
EXCHANGE=binanceusdm EXCHANGE_API_KEY=... EXCHANGE_API_SECRET=... \
  python live_trader.py run --execute                     # actually send orders via ccxt
python live_trader.py status                              # state + today's target book
python live_trader.py backtest --capital 300000           # vectorised full-history sanity of the live logic
```
`run` without `--execute` always previews (dry-run). State persists to
`research/live_trader_state.json` (idempotent: one cycle per UTC day). Needs `pip install ccxt`
only for `--execute`.

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

## Fidelity to the tested system (`research/fidelity_check.py`)
Run it before every deploy — it proves the live target book uses the backtested engine's
own code on the same data, sleeve by sleeve. **All four sleeves now PASS:**
- **CORE — identical** (`production_strategy.book_weights`, ΔW = 0).
- **SPINE — identical selection + params** (top-30-by-30d-$vol from the *same
  survivorship-free pool*, inverse-vol weighted, with **walk-forward-selected params**
  via `latest_spine_params`, ΔW = 0).
- **BTC1H / ETH8H — faithful bracket runner** (`intraday_live.position_now`): reuses the
  exact `sig_regime_pullback` + `bracket_ext` + walk-forward param selection, and derives
  the *current open position* from history on the proper 1H/8H clock (no longer the
  daily-bar proxy). It correctly holds a position opened on a prior bar until its bracket
  closes — e.g. it shows BTC1H **long** today, which the old daily proxy missed.

The earlier four residuals are closed: ✅ intraday hourly runner, ✅ SPINE WF params,
✅ daily pool refresh (`combined_book(refresh=True)` / `refresh_pool()`), ✅ signals on
spot (matches the backtest's data).

**Only two residuals remain, both inherent to live trading (not signal fidelity):**
1. **Execution venue** — signals are on spot (faithful to the backtest); fills are on
   USDT-M futures. Daily CORE/SPINE are ~identical; intraday can diverge slightly during
   funding/basis events (the reviewer's point — accepted, monitor).
2. **Unlisted names** — pool-selected coins are routed as `<SYM>USDT`; any without a
   futures listing is dropped + renormalised at execution.

*(Perf note: `position_now` and `latest_spine_params` re-select params each cycle by
re-running the walk-forward rule; cache them daily in production — they change only when
a fold rolls.)*

## Going live (no strategy paper-trading, per request) — checklist
You've chosen to skip the paper-trading-the-strategy period — i.e. you accept the
backtested alpha without a live forward test. That is a strategy call. The steps below
are **execution-sanity** (not losing money to a *bug*) — a different thing, and
non-negotiable, because the live order code is untested against a real account:
- [ ] `run` (dry-run) and read the **order preview**; confirm sides/sizes match the
      target book and your intuition (today: long DOGE/ETH, short LTC/ADA/XLM/BCH).
- [ ] `backtest` reproduces the harvest shape (CORE+SPINE m=2 → ~5–6× cash on $300k,
      self-funding, principal back fast).
- [ ] **One cycle on testnet or tiny size** via `--execute`: confirm orders fill and
      sizing/leverage/sign are correct and positions reconcile. This catches wiring bugs
      (wrong qty, inverted side, missing leverage) before real size.
- [ ] Fund the **$300k base once**; start at **reduced leverage/size**, scale only after
      live fills match the preview.
- [ ] Wire the **operator alerts**: the bot prints `2x HARVEST`, `STOP`, and `year-end`
      lines — you (or a transfer script) move withdrawn cash to cold and keep the trading
      account at base. **Self-funding invariant:** never wire in more than the initial
      base; cover losing-year resets from withdrawn `cum_cash`.
- [ ] Set a hard **kill switch** + exchange-side liquidation buffers (see below).

> What you accept by skipping paper: an unvalidated-live edge **and** first-time order
> code at 2× leverage. The testnet/tiny check is the minimum that stops a *bug* from
> compounding the *strategy* risk; a single overnight gap at 2× can still be ruinous.

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
- **`LiveBroker` is implemented (ccxt) but UNTESTED against a real account here.** It
  defaults to dry-run; `--execute` sends post-only limits, sets isolated leverage, and
  reconciles vs current positions. Verify on testnet/tiny size first (see checklist).
  Order/position/leverage calls vary by exchange — confirm they map to yours.
- **Harvest withdrawals & the −40% flatten are OPERATOR ALERTS**, not auto-transfers
  (deliberately — moving real funds is left manual/scripted by you).
- **Capacity is finite** and **past performance is not predictive.**
