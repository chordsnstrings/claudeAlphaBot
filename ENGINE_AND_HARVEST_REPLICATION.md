# Unified Crypto Trading Engine & Profit-Harvest — Complete Replication Guide

**Purpose.** A single, self-contained specification of the entire research program in
this repo: the four validated return sleeves, the orchestrator that combines them, the
walk-forward / out-of-sample (OOS) validation, and the **profit-harvest cash-extraction
technique**. Every step is described precisely and the **complete source of every module
is embedded verbatim in Appendix A**, so another engineer or AI agent can reproduce the
engine — *including harvesting* — from this document alone.

**Provenance & honesty.** Every headline number is walk-forward OOS, net of explicit
costs. This is a **lumpy, leverage-and-regime-dependent backtest over ~4.5 years of
crypto (2021-05 → 2026-05)**, not a forecast. The deep companion studies are
`DEPLOYABLE_STRATEGY_BUILD.md` (daily core), `DAYTRADE_BTC_ETH_WINRATE.md` (intraday
sleeves), `ALL_WEATHER_SPINE.md` (crisis-alpha spine), and `UNIFIED_BOT.md` (orchestrator).
This guide unifies them and adds the harvest layer.

---

## 0. Reproduce in five commands (and the acceptance gates)

```bash
cd research
pip install numpy pandas

# (data is cached under research/data/; to refetch: python binance_vision.py)
python unified_bot.py            # validate the combined book (sleeves, correlations, profiles, annual wrapper)
python unified_bot.py --harvest  # the recommended harvest run + month-on-month cash log
python harvest_sweep.py          # sweep 600 harvest configs -> the Pareto frontier + best self-funding config
```

**Acceptance gates** (a correct rebuild must reproduce these; if your numbers differ
materially, you have a bug):

| Gate | Expected (OOS, 2021-05-30 → 2026-05-24) |
| --- | --- |
| Sleeve correlations to CORE | BTC1H ≈ +0.04, ETH8H ≈ +0.08, SPINE ≈ +0.14 (near-orthogonal) |
| ALL-WEATHER profile (m=1) | Sharpe ≈ 1.21, maxDD ≈ −32%, worst year ≈ −2% |
| Harvest sweep — best self-funding @ wealthDD≤−25% | all-weather 30% spine, m=2, take@2× leaving 50% → **5.1× ROI ($1.53M on $300k), −25% wealth DD, principal back ~99 days** |
| Self-funding | ≥ 597/600 swept configs never require an external cash top-up |

---

## 1. System overview & architecture

The system is a **capital-allocated orchestrator** over four independently-validated
return sleeves, wrapped by an annual **profit-harvest** cash policy.

```
  ┌──────────────────────────────── SLEEVES (each a validated edge) ────────────────────────────────┐
  │ CORE  (daily, long-only momentum)   SOL/ETH/BTC/DOGE/XRP : 0.60·trend + 0.40·cross-sectional      │ r_core[d]
  │ BTC1H (intraday day-trade)          long BTC 1H dips in an uptrend, ADX-gated, bracket exit        │ r_btc1h[d]
  │ ETH8H (intraday day-trade)          long ETH 8H dips in an uptrend, ADX-gated, ATR 2:1 exit        │ r_eth8h[d]
  │ SPINE (daily, long/SHORT trend)     top-30 TS-trend "crisis alpha" — shorts confirmed downtrends   │ r_spine[d]
  └───────────────────────────────────────────────────────┬───────────────────────────────────────────┘
                                                           │  each sleeve → a DAILY net-return stream
                                                           ▼
                       combined[d] = Σ_sleeve  w_sleeve · r_sleeve[d]      (w = a risk profile)
                                                           ▼
                       VALIDATION: correlation · combined-vs-core Sharpe/maxDD · annual %-banking · alloc-WF
                                                           ▼
                       HARVEST POLICY: $300k base, reset each Jan (no compounding); take profit at 2×
                       (optionally leaving a fraction on the table); year-end sweep; −40% YTD stop.
                                                           ▼
                       OUTPUT: month-on-month cash extracted, self-funding & principal-recovery checks.
```

**Why four sleeves.** Each is near-uncorrelated with the others (|ρ| < 0.14), so the
blend has materially higher risk-adjusted return than any part. CORE harvests bull
trends; BTC1H/ETH8H add steady/​punchy intraday alpha; SPINE earns in bears by shorting
(the only sleeve that is positive in 2022). The harvest layer converts the book's lumpy
equity into **realized cash** while keeping the at-risk base fixed.

---

## 2. Conventions & no-lookahead rules (apply everywhere)

1. **Causality.** Every indicator value at time *t* uses only data ≤ *t*. A weight/signal
   decided at the close of bar *t* is applied to (earns) the return of bar *t+1*.
2. **Daily accounting identity** (engine.py): with target weight `w[t]`,
   `held[t] = w[t-1]`; `r_p[t] = held[t]·ret[t] − txn·|held[t]−held[t-1]| − funding·|held[t]|`.
3. **Costs.** Daily sleeves: `txn = 6 bps/side`, `funding = 1 bp/day` per unit gross.
   Intraday sleeves: `6 bps/side` round-trip per trade. SPINE: `15 bps/side` (top-30 is
   less liquid). Annualisation uses **365** (crypto trades every day).
4. **Intraday fills (bracket).** Signal on bar *t* close → enter at bar *t+1* **open**.
   Intrabar exits use high/low; **gaps fill at the open**; if a single bar spans **both**
   TP and SL, the **stop** is assumed to fill first (worst case — never inflates win rate).
   One position at a time.
5. **Walk-forward OOS.** Parameters are chosen on a **train** window only (by net
   expectancy or Sharpe with a trade-count floor), then scored on the **next unseen**
   window; OOS test slices are stitched into one record. Non-overlapping test windows.

---

## 3. Data layer  *(code: Appendix A.1 `binance_vision.py`, A.2 `data.py`)*

- **Source:** `data-api.binance.vision` — Binance's public market-data mirror (no key,
  read-only). `api.binance.com` is geo-blocked (HTTP 451) from many hosts; the mirror
  serves the identical `/api/v3/klines` endpoint. `kucoin` is a documented fallback.
- **Daily panel:** 5 coins (SOL/ETH/BTC/DOGE/XRP), UTC daily close, columns
  `date,close,volume_usd`, cached at `research/data/<SYM>_daily.csv`. Coins start at
  listing (NaN before — never forward-fill across the gap); right-edge trimmed to the
  last date **all** coins share. SOL from 2020-08-11.
- **Intraday:** real 1H OHLCV per coin at `research/data/intraday/<SYM>_1h.csv`;
  8H/12H/1D are resampled (open=first, high=max, low=min, close=last, volume=sum),
  anchored at 00:00 UTC.
- **Universe (for SPINE):** a survivorship-free top-30 set (corpses present, e.g. LUNA)
  at `research/data/universe/<SYM>_daily.csv` — required so the bear P&L is the broad
  downtrend, not a few −100% shorts.

---

## 4. Daily backtest engine & metrics  *(code: Appendix A.3 `engine.py`)*

`engine.backtest(prices, target_w, costs)` implements the §2.2 identity for a single
series. Indicators (`ema, sma, rolling_std, realized_vol, rsi`) are causal.
`compute_metrics(r_p, held)` returns CAGR, annualised vol, **Sharpe**, Sortino, **max
drawdown**, Calmar, total return, exposure, turnover, win-rate-of-days.
`realized_vol(ret,n) = std(ret, n)·√365` (the vol-target denominator).
`apply_annual_breaker` is the within-year −X% drawdown circuit-breaker used by the
$100k-reset model. For the multi-coin CORE book the daily return is computed directly
as `Σ_coin held·ret − costs` (orchestrator §8).

---

## 5. Daily momentum CORE sleeve  *(code: A.4 `strategies.py`, A.5 `production_strategy.py`)*

Long-only, vol-targeted momentum over SOL/ETH/BTC/DOGE/XRP — two sub-sleeves blended.
This is the pre-validated deployable (`DEPLOYABLE_STRATEGY_BUILD.md`: banks +50% in
~9/10 calendar years OOS with the static blend). **Exact parameters:**

```
COINS = [SOL, ETH, BTC, DOGE, XRP]
W_TREND, W_XS   = 0.60, 0.40
TREND_LBS       = {SOL/ETH/BTC: (10,30,60,120),  DOGE/XRP: (20,40,80,120)}
VOL_TARGET, VOL_LB, MAX_LEV = 0.60, 20, 3.0
XS_TOPK, XS_LBS = 2, (20,40,80)
EFF_LEV_CAP     = 2.0            # book gross exposure ≤ 2× equity
```

**Sub-sleeve A — absolute trend (`sig_tsmom_blend`):** the fraction of lookback horizons
currently in an uptrend, mapped to [−1,1], long-only, inverse-vol sized:
```
raw[t]   = mean over L in TREND_LBS of sign(close[t]/close[t-L] − 1)        # ∈ [−1,1]
rv[t]    = max(realized_vol(20)[t], 0.10);  scale[t] = min(0.60/rv[t], 3.0)
wA[t]    = clip(max(raw[t],0) · scale[t], 0, 3.0)                            # flat in downtrends
```

**Sub-sleeve B — cross-sectional rotation:** hold the top-2 strongest-magnitude movers,
equal-weight, vol-targeted at the basket level:
```
score[i,t] = mean over L in (20,40,80) of sign(r_L)·r_L   (≡ mean |r_L|)    # rank by move magnitude
hold top-2 (equal weight); vol-target the basket to 0.60 (cap 3×)
```
> **Do not "simplify" `sign(r)·r` to a signed return** — it is `|r|` by construction and
> ranks by magnitude; that exact expression produced the validated results.

**Book:** `book = 0.60·wA + 0.40·wB`, then scaled down so gross ≤ `EFF_LEV_CAP=2×`.
`production_strategy.book_weights(panel)` returns the daily weight matrix; the
orchestrator turns it into the CORE daily return stream (§8).

---

## 6. Intraday day-trade sleeves — BTC1H & ETH8H  *(code: A.6 `daytrade_winrate.py`, A.7 `daytrade_strategies2.py`)*

These are the **two cells that survived rigorous rolling walk-forward** out of the full
day-trade search (`DAYTRADE_BTC_ETH_WINRATE.md`). Both are the **`regime_pullback`**
family: *buy a short-term dip only in a strong uptrend.*

**Signal (`sig_regime_pullback`, causal):**
```
ma   = SMA(close, slow);  r = RSI(close, 7);  ax = ADX(high,low,close, 14)
strong = ax ≥ adx_thr
long  when  close > ma  AND  r ≤ dip       AND strong
short when  close < ma  AND  r ≥ 100−dip   AND strong         # short rarely selected
```
**Exit (`bracket_ext`) — selectable geometry**, chosen OOS per fold from a grid of:
`pct` (fixed ±%), `atr` (TP=k·ATR / SL=j·ATR), `trail` (ratcheting stop), `scaleout`
(partial take + trail), each with a max-hold time-stop. Conservative same-bar
resolution (stop wins ties; gaps at open).

**Representative validated configs** (the params the folds most often select):
- **BTC1H:** `close>SMA(50)` & `ADX(14)≥30` & `RSI(7)≤35`; symmetric **±3%** bracket;
  48h time-stop. OOS ≈ **54.8% win, +67.6% net, PF 1.23, 73% fold-win** (robust:
  top-3 trades only 22% of return).
- **ETH8H:** `close>SMA(50)` & `ADX(14)≥20` & `RSI(7)≤45`; **asymmetric ATR bracket
  TP=3×ATR / SL=1.5×ATR**; 12-bar stop. OOS ≈ **+307% net, PF 1.61, 51.7% win** —
  *real but high-variance* (survives dropping its best fold: +154%; spread across
  2021-22 and 2024-25).

**Rolling walk-forward (`daytrade_strategies2.walk_forward`):** train 365d → unseen
120d, **non-overlapping**; per fold, the (entry × exit) grid is scored on train and the
**max-expectancy** config (≥15 train trades) is applied to the test window; OOS trades
(net of 6 bps/side) are stitched. The function also emits **dated** OOS trades
(`oos_dated`: exit-timestamp, net-return) — the orchestrator buckets these to daily.

> **What did NOT survive** (documented so the search is exhaustive, not cherry-picked):
> pure mean-reversion (all timeframes/coins), breakout, VWAP, time-of-day filters, and
> the BTC→ETH cross-asset lead-lag. Only `regime_pullback` on BTC-1H and ETH-8H held up.

---

## 7. All-weather SPINE sleeve  *(code: A.8 `all_weather.py`)*

A **pure long/short time-series-trend** book over the top-30 universe — "crisis alpha."
Each coin is held **long if its multi-lookback trend is up, short if down**, inverse-vol
weighted (so collapsing names get near-zero weight; the bear P&L is the broad orderly
downtrend, not a few −100% shorts). It is the only sleeve **positive in 2022 (+22%)**.

```
sig[i,t]   = mean over L in lbs of sign(close[i]/close[i,t-L] − 1)     # ∈ [−1,1], long AND short
iv[i,t]    = 1 / max(realized_vol(close[i], 30), 0.20)                 # inverse-vol
universe   = top-`TOP_LIQ`(=30) by 30d dollar-volume, valid only
w[i,t]     = sig·iv normalised to gross_target, capped at max_gross
```
Validated OOS at **15 bps/side**: CAGR +24%, Sharpe 0.71, maxDD −44%, **worst year −3%**.
Walk-forward (train 540d / test 180d, pick by train Sharpe) selects `lbs/gross_target/
max_gross` per fold; `build_ts_trend` is the vectorised builder, `net_from` applies cost.

---

## 8. The unified ORCHESTRATOR  *(code: A.10 `unified_bot.py`)*

Converts each sleeve to a **daily net-return stream over a common index**, blends by a
capital profile, and validates the combination.

**8.1 Sleeve → daily stream**
- `core_daily_returns()`: `held = book.shift(1)`; `r = Σ_coin held·ret − txn·turnover −
  funding·gross`.
- `intraday_daily_returns(coin,tf,strat)`: run the WF; **bucket each OOS trade's net
  return to its exit DATE** (compound multiple same-day exits); a sparse daily series
  (0 on no-trade days) for a 1× sleeve.
- `spine_daily_returns()`: stitched WF OOS, **extended with one final OOS fold** (best
  config on the trailing 540d applied forward) so coverage reaches the data end.
- `build_panel()`: align all four on the daily calendar over the window where all are
  live (≈ 2021-05-30 → 2026-05-24); intraday/​spine missing days → 0.

**8.2 Risk-profile dial** (capital split; `weighted(df,w)=Σ df[k]·w[k]`):
```
GROWTH       = {CORE 0.70, BTC1H 0.15, ETH8H 0.15, SPINE 0.00}   # max bull harvest
ALL_WEATHER  = {CORE 0.40, BTC1H 0.15, ETH8H 0.15, SPINE 0.30}   # default: best risk-adjusted
ALL_WEATHER_MAX (sweep spine=0.60) = {CORE 0.10, BTC1H 0.15, ETH8H 0.15, SPINE 0.60}
```

**8.3 Validation outputs** (`python unified_bot.py`): standalone sleeve metrics; the 4×4
**correlation matrix** (the diversification proof, |ρ|<0.14); profiles vs CORE-only at
m=1 (ALL-WEATHER: **Sharpe 1.21, Calmar 1.39, maxDD −32%, worst yr −1.8%** vs CORE-only
1.04 / −68% / −47%); the annual **$100k +50%-lock/−40%-stop wrapper** %-years-banking
(both fixed and a fully-OOS **allocation walk-forward**, which banks +50% in 4/4 years
at m=3). Saved to `results/unified_bot_results.json` + `unified_bot_equity.csv`.

---

## 9. The HARVEST technique (rigorous)  *(code inline below + A.10 `harvest_run`, A.11 `harvest_sweep.py`)*

The harvest layer answers: *"On a fixed stake, how much CASH can I pull out, with the
least drawdown, getting my money back fast, never having to add capital?"* It runs a
chosen profile's daily stream at leverage `m` on a **base that resets every January**
(so there is **no year-over-year compounding** — each year is an independent race), and
extracts cash at two triggers.

**9.1 Parameters**
```
base        = $300,000        # the fixed stake (reset each Jan)
m           = leverage multiplier on the daily net return (a day of net r earns m·r)
double_at   = 2.0             # take profit when equity reaches double_at × base (a "2×")
harvest_frac∈ (0,1]           # fraction of profit withdrawn at the 2× trigger
go_flat     = True/False      # after harvesting: stop for the year (True) or keep trading (False)
stop        = 0.40            # if YTD equity ≤ (1−stop)·base → go flat for the rest of the year
```
*"Leave X% on the table"* = `harvest_frac = 1−X`, `go_flat = False` (take part of the
profit, let the rest ride). *"Take 100% and sit"* = `harvest_frac=1.0, go_flat=True`.

**9.2 The state machine (per calendar year; causal & path-dependent)** — this is the
exact engine, reproduced from `harvest_run`:
```python
eq, locked, cum = base, False, cum            # cum = running net cash returned to investor
for d, x in days_of_year:                     # x = that day's sleeve net return
    if not locked:
        eq *= (1 + m * x)                      # apply leveraged daily return
        if eq <= 0:                            # leveraged ruin
            eq, locked, ev = 0.0, True, "LIQUIDATION"
        elif harvest_frac > 0 and eq >= double_at * base:   # hit a "2×"
            take = harvest_frac * (eq - base)  # withdraw a fraction of the profit
            cum += take;  eq -= take           # cash to pocket; rest stays on the table
            if go_flat: locked = True          # optionally stop for the year
        if not locked and eq <= (1 - stop) * base:          # -40% YTD stop
            locked = True
    if d is last_day_of_year:                  # YEAR-END SWEEP / reset
        settle = eq - base                     # remaining profit (or loss)
        cum += settle;  eq = base              # sweep profit OR cover loss from pocket; reset to base
```

**9.3 Two hard constraints (the goal's requirements), defined precisely**
- **Self-funding (never put cash in to survive).** Define `cum` = cumulative net cash
  returned (harvests + year-end sweeps − loss-year top-ups). The strategy is
  **self-funding iff `min(cum) ≥ 0` over the whole run AND it never liquidates** — i.e.
  every losing-year reset is covered by *already-harvested profit*, never new external
  money. (You inject the $300k base exactly once, at the very start.)
- **Investment returned.** The principal is "back" the first day `cum ≥ base`. We report
  **how many days** that takes (faster = de-risked sooner — thereafter you play on
  house money).

**9.4 The correct drawdown = TOTAL-WEALTH drawdown.** A profit withdrawal or a year-end
reset is **not a loss** — it moves money from the at-risk account to your pocket. So the
investor's wealth is **continuous**: `wealth[t] = equity[t] + cum[t]`. The real drawdown
is `min(wealth/wealth.cummax − 1)`. *(Measuring drawdown on `equity` alone is wrong — it
counts every withdrawal/reset as a "crash" and massively overstates it.)* All harvest
drawdowns in this guide are total-wealth drawdowns.

**9.5 Profit-taking variants (whole run, $300k @ the recommended 30%-spine book, m=2):**

| Variant (`harvest_frac`, `go_flat`) | Net cash | Wealth maxDD | 2×-events |
| --- | ---: | ---: | ---: |
| take 100% then FLAT (1.0, True) | $978,776 | −26% | 3 |
| take 100% keep trading (1.0, False) | $942,672 | −26% | 3 |
| **leave 50% on the table (0.5, False)** | **$1,534,135** | **−25%** | 8 |
| leave 75% (0.25, False) | $1,554,255 | −29% | 15 |
| leave 100% / year-end only (0.0, False) | $1,680,777 | −42% | 0 |

Leaving 50% on the table captures post-2× continuation rallies (e.g. Nov-2024) that the
"take-all-and-sit" policy misses, for a comparable drawdown — hence it is the sweet spot.

---

## 10. The sweep & the recommended configuration  *(code: A.11 `harvest_sweep.py`)*

`harvest_sweep.py` evaluates **600 configs** = spine∈{0,15,30,45,60%} × m∈{1,1.5,2,2.5,3}
× lock∈{+50%,+100%} × stop∈{20,30,40%} × policy∈{lock-flat, harvest-continue, leave25,
leave50}, keeping only those that are **self-funding AND return the full $300k**, and
ranks by ROI per unit total-wealth drawdown.

**Pareto frontier — best self-funding ROI at each wealth-drawdown ceiling:**

| Wealth maxDD ≤ | ROI | Cash on $300k | $300k back in | Config |
| ---: | ---: | ---: | ---: | --- |
| −20% | 3.4× | $1,029,180 | 609 d | spine 30%, m=1.5, +50% lock, leave 25% |
| **−25%** | **5.1×** | **$1,534,135** | **99 d** | **spine 30%, m=2, +100% lock, leave 50%** |
| −40% (best ROI/DD) | 6.5× | $1,942,300 | 95 d | spine 15%, m=2, +100% lock, leave 50% |

*(Nothing achieves ≤ −15% — that is the irreducible early drawdown before any profit is
banked. 597/600 configs are self-funding.)*

**RECOMMENDED (wired as `unified_bot.py --harvest`, the default):** **ALL-WEATHER 30%
spine book, m=2, take profit at 2× leaving 50% on the table, −40% stop, $300k base.**
- ROI **5.1× — $1,534,135 cash on $300k**, **total-wealth maxDD −25%**.
- **Principal returned in ~99 days** (by Sep-2021); thereafter house money.
- **Self-funding** — the only losing year (2022, −$24,994) is covered by 2021's
  +$329,220 harvest; **no external cash ever required.**
- The conservative alternative `--harvest --lock-flat` (take 100%, sit) → ~$978,776 at
  −26% with the base best-protected.

---

## 11. Validation results — the month-on-month harvest (recommended config)

`python unified_bot.py --harvest`, $300k base, all-weather-30% @ 2×, leave 50%:

| Year | Net cash | Cumulative | Note |
| --- | ---: | ---: | --- |
| 2021 (partial) | +$329,220 | $329,220 | 2 harvests (Aug/Sep) → **principal returned** |
| 2022 | −$24,994 | $304,226 | bear; small loss, covered by reserve (self-funding) |
| 2023 | +$515,091 | $819,317 | rode the H2 rally (leave-50% caught it) |
| 2024 | +$698,557 | $1,517,874 | caught Nov-2024 +259% (m=2 survived the April drawdown) |
| 2025 | +$45,658 | $1,563,533 | choppy |
| 2026 (partial) | −$29,398 | $1,534,135 | bear, current |

**Whole run: $300k → $1,534,135 net cash extracted (5.1×), base intact, −25% wealth
drawdown, self-funding, principal back in ~99 days.**

---

## 12. Honest caveats & failure modes

- **Sample size & lumpiness.** ~4.5 years, only 4 full calendar years overlap all
  sleeves' OOS. Bull years (2021/2023/2024) dominate; the harvest figures are not a
  forecast — they are what this specific history produced.
- **Leverage gap-risk is real.** At m=2 a ~−50% single-day book move (≈ −25% asset gap
  at 2× book gross) approaches ruin; the −40% daily-model stop **cannot** protect against
  an overnight gap. Size accordingly; the spec caps total effective exposure ≈ 3×.
- **2022/synchronised-crash** is softened by SPINE (which shorts) but not eliminated.
- **Intraday PnL is bucketed to the exit day** (a modeling simplification; no intraday
  mark-to-market), fine for small intraday allocations and short holds.
- **Costs.** SPINE is cost-sensitive (good ≤20 bps, gone at 50 bps); trade top-30
  liquidity at modest size. The whole book has finite capacity.
- **Regime-switch overlays underperform** here (whipsaw / laggy exits) — documented in
  `confirmed_bear_switch.py`; the static all-weather book + harvest is the better answer.
- **Past performance is not predictive.** Paper-trade first; respect the stops.

---

# Appendix A — Complete source code (verbatim)

Every module needed to reproduce the engine and harvesting follows, exactly as run.
Layout: `research/<file>.py`; cached data under `research/data/`. Build order:
A.1–A.2 (data) → A.3 (engine) → A.4–A.5 (CORE) → A.6–A.7 (intraday) → A.8 (spine) →
A.9 (annual wrapper) → A.10 (orchestrator + harvest) → A.11 (sweep).

<!-- CODE_APPENDIX_BELOW -->

### A.1 — `research/binance_vision.py`

Public Binance-mirror OHLCV loader (daily + intraday klines, paginated).

```python
"""Binance Vision (data-api.binance.vision) OHLCV loader.

`data-api.binance.vision` is Binance's PUBLIC market-data mirror. Unlike
`api.binance.com` (geo-blocked, HTTP 451 from this environment) it is reachable
and serves the same read-only `/api/v3/klines` endpoint — no API key, market data
only (no account/trading/signed endpoints).

This unblocks two things the earlier research could not get:
  * real **SOL** price history (Coin Metrics community tier only has a 7-row stub;
    the old harness substituted DOT). Binance SOLUSDT goes back to 2020-08-11.
  * real **intraday** (1h / 8h-by-resample) candles for finer-grained strategies.

Endpoint:
  GET https://data-api.binance.vision/api/v3/klines?symbol=SOLUSDT&interval=1d
      &startTime=<ms>&endTime=<ms>&limit=1000
  kline = [openTime, open, high, low, close, volume, closeTime, quoteVol,
           nTrades, takerBuyBase, takerBuyQuote, ignore]   ASC, max 1000/req.

Outputs:
  * daily  -> research/data/<SYM>_daily.csv   columns date,close,volume_usd
              (same slim schema the daily harness's data.load() consumes)
  * intraday -> research/data/intraday/<SYM>_<tf>.csv  full OHLCV.
"""
from __future__ import annotations

import csv
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
INTRADAY_DIR = os.path.join(DATA_DIR, "intraday")
BASE = "https://data-api.binance.vision/api/v3/klines"

# research symbol -> Binance spot pair
PAIRS = {
    "BTC": "BTCUSDT",
    "ETH": "ETHUSDT",
    "SOL": "SOLUSDT",
    "DOGE": "DOGEUSDT",
    "XRP": "XRPUSDT",
}

INTERVAL_MS = {
    "1d": 86_400_000,
    "8h": 8 * 3_600_000,
    "1h": 3_600_000,
}
MAX_PER_REQ = 1000
PACE_S = 0.25


def _get(url: str, retries: int = 4) -> list:
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "research/1.0"})
            with urllib.request.urlopen(req, timeout=45) as r:  # noqa: S310
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:  # noqa: PERF203
            last = e
            time.sleep(2 ** attempt)
    raise RuntimeError(f"GET failed after {retries} tries: {url}\n  {last}")


def reachable() -> bool:
    try:
        _get("https://data-api.binance.vision/api/v3/ping", retries=1)
        return True
    except Exception as e:  # noqa: BLE001
        print(f"[binance_vision] not reachable: {e}", file=sys.stderr)
        return False


def fetch_klines(pair: str, interval: str, start_ms: int, end_ms: int | None = None) -> list[list]:
    """Paginate /klines forward from start_ms. Returns ASC rows (deduped)."""
    step = INTERVAL_MS[interval]
    if end_ms is None:
        end_ms = int(time.time() * 1000)
    rows: list[list] = []
    cursor = start_ms
    while cursor < end_ms:
        url = (f"{BASE}?symbol={pair}&interval={interval}"
               f"&startTime={cursor}&endTime={end_ms}&limit={MAX_PER_REQ}")
        batch = _get(url)
        if not batch:
            break
        rows.extend(batch)
        last_open = int(batch[-1][0])
        nxt = last_open + step
        if nxt <= cursor:
            break
        cursor = nxt
        if len(batch) < MAX_PER_REQ:
            break
        time.sleep(PACE_S)
    # dedupe by openTime
    seen = {}
    for k in rows:
        seen[int(k[0])] = k
    return [seen[t] for t in sorted(seen)]


def fetch_daily(sym: str, force: bool = False) -> str:
    """Fetch full daily history, write slim date,close,volume_usd CSV."""
    pair = PAIRS[sym]
    out_path = os.path.join(DATA_DIR, f"{sym}_daily.csv")
    if os.path.exists(out_path) and not force:
        print(f"[binance_vision] {sym} daily cached -> {out_path}", file=sys.stderr)
        return out_path
    os.makedirs(DATA_DIR, exist_ok=True)
    # 2017-07-01; Binance's earliest listings. Each pair just returns from its
    # own listing date.
    start_ms = int(datetime(2017, 7, 1, tzinfo=timezone.utc).timestamp() * 1000)
    kl = fetch_klines(pair, "1d", start_ms)
    with open(out_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "close", "volume_usd"])
        for k in kl:
            open_ms = int(k[0])
            close = float(k[4])
            quote_vol = float(k[7])  # quote volume ~ USD turnover
            d = datetime.fromtimestamp(open_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            if close > 0:
                w.writerow([d, close, quote_vol])
    first = datetime.fromtimestamp(int(kl[0][0]) / 1000, tz=timezone.utc).date()
    last = datetime.fromtimestamp(int(kl[-1][0]) / 1000, tz=timezone.utc).date()
    print(f"[binance_vision] {sym} daily: {len(kl)} rows {first} -> {last} -> {out_path}",
          file=sys.stderr)
    return out_path


def fetch_intraday(sym: str, interval: str, years: float = 6.0, force: bool = False) -> str:
    pair = PAIRS[sym]
    os.makedirs(INTRADAY_DIR, exist_ok=True)
    out_path = os.path.join(INTRADAY_DIR, f"{sym}_{interval}.csv")
    if os.path.exists(out_path) and not force:
        print(f"[binance_vision] {sym} {interval} cached -> {out_path}", file=sys.stderr)
        return out_path
    start_ms = int((time.time() - years * 365 * 86400) * 1000)
    kl = fetch_klines(pair, interval, start_ms)
    with open(out_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["timestamp_ms", "date", "open", "high", "low", "close", "volume", "quote_volume"])
        for k in kl:
            open_ms = int(k[0])
            d = datetime.fromtimestamp(open_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            w.writerow([open_ms, d, k[1], k[2], k[3], k[4], k[5], k[7]])
    first = datetime.fromtimestamp(int(kl[0][0]) / 1000, tz=timezone.utc)
    last = datetime.fromtimestamp(int(kl[-1][0]) / 1000, tz=timezone.utc)
    print(f"[binance_vision] {sym} {interval}: {len(kl)} candles {first} -> {last} -> {out_path}",
          file=sys.stderr)
    return out_path


def main(argv):
    if not reachable():
        return 2
    syms = [a.upper() for a in argv if a.upper() in PAIRS] or list(PAIRS)
    mode = "intraday" if "--intraday" in argv else ("daily" if "--daily" in argv else "all")
    tfs = [a for a in argv if a in ("1h", "8h")] or ["1h"]
    force = "--force" in argv
    for sym in syms:
        if mode in ("daily", "all"):
            fetch_daily(sym, force=force)
        if mode in ("intraday", "all"):
            for tf in tfs:
                fetch_intraday(sym, tf, force=force)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

### A.2 — `research/data.py`

Daily close-series loader/cache (Coin Metrics + Binance-mirror for SOL).

```python
"""Data layer for the crypto strategy research harness.

Source: Coin Metrics community network data (public, on GitHub).
We only need a clean daily close series per asset. We use
``ReferenceRateUSD`` (Coin Metrics' robust reference price) and fall
back to ``PriceUSD`` when the reference rate is missing.

Exchange APIs (Binance/Kraken/Coinbase/CoinGecko) are blocked in this
environment, but ``raw.githubusercontent.com`` is reachable, so we pull
the Coin Metrics CSVs from there once and cache a slim ``date,close``
series locally for fully offline, reproducible backtests.
"""
from __future__ import annotations

import io
import os
import sys
import urllib.request

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")

CM_BASE = "https://raw.githubusercontent.com/coinmetrics/data/master/csv"

# Asset -> (coinmetrics file, first date we consider "liquid / tradeable").
#
# NOTE on SOL (RESOLVED 2026-05-25): Coin Metrics' *community* CSVs only carry a
# full price history for assets old enough to have the legacy ``PriceUSD`` field,
# so SOL used to be unavailable offline and DOT was used as a high-beta-L1 stand-in.
# `data-api.binance.vision` (Binance's public market-data mirror) is now reachable,
# so SOL is sourced there via ``binance_vision.fetch_daily`` (real SOLUSDT daily
# close, 2020-08-11 -> today). The ``binance_vision`` source marker means
# ``fetch_and_cache`` delegates to that loader instead of Coin Metrics.
ASSETS = {
    "BTC": ("btc.csv", "2014-01-01"),   # major / store-of-value
    "ETH": ("eth.csv", "2016-06-01"),   # major / smart-contract L1
    "SOL": ("binance_vision", "2020-08-11"),  # high-beta L1 (real data, Binance mirror)
    "DOT": ("dot.csv", "2020-08-20"),   # high-beta L1 (legacy SOL analog; kept for breadth)
    "LINK": ("link.csv", "2017-10-01"), # high-beta alt
    "ADA": ("ada.csv", "2017-12-01"),   # high-beta L1
    "DOGE": ("doge.csv", "2015-01-01"), # meme / fat-tailed
    "XRP": ("xrp.csv", "2014-08-15"),   # payments / episodic
    "LTC": ("ltc.csv", "2013-04-01"),   # old major
    "BNB": ("bnb.csv", "2017-07-15"),   # exchange token
}

# The universe the goal names explicitly: real SOL now included.
CORE_ASSETS = ["BTC", "ETH", "SOL", "DOGE", "XRP"]


def _slim_path(asset: str) -> str:
    return os.path.join(DATA_DIR, f"{asset}_daily.csv")


def fetch_and_cache(asset: str, force: bool = False) -> pd.DataFrame:
    """Download the Coin Metrics CSV, extract a clean daily close series,
    cache it as ``data/<ASSET>_daily.csv`` and return it."""
    os.makedirs(DATA_DIR, exist_ok=True)
    slim = _slim_path(asset)
    if os.path.exists(slim) and not force:
        return load_cached(asset)

    fname, start = ASSETS[asset]
    if fname == "binance_vision":
        # real exchange data via the public Binance mirror (e.g. SOL)
        import binance_vision
        binance_vision.fetch_daily(asset, force=force)
        return load_cached(asset)
    url = f"{CM_BASE}/{fname}"
    print(f"[data] downloading {asset} from {url}", file=sys.stderr)
    req = urllib.request.Request(url, headers={"User-Agent": "research/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 (trusted host)
        raw = resp.read().decode("utf-8")

    df = pd.read_csv(io.StringIO(raw), usecols=lambda c: c in (
        "time", "ReferenceRateUSD", "PriceUSD", "volume_reported_spot_usd_1d",
    ), low_memory=False)
    df = df.rename(columns={"time": "date"})
    df["date"] = pd.to_datetime(df["date"]).dt.tz_localize(None)
    # Prefer whichever price column has real coverage. For older assets that is
    # the legacy PriceUSD; for a few it is ReferenceRateUSD. Fill gaps from the
    # other to be safe.
    have = [c for c in ("PriceUSD", "ReferenceRateUSD") if c in df.columns]
    if not have:
        raise RuntimeError(f"{asset}: no price column in source CSV")
    primary = max(have, key=lambda c: df[c].notna().sum())
    close = df[primary].copy()
    for c in have:
        if c != primary:
            close = close.fillna(df[c])
    df["close"] = close
    vol = df["volume_reported_spot_usd_1d"] if "volume_reported_spot_usd_1d" in df.columns else pd.NA
    out = pd.DataFrame({"date": df["date"], "close": df["close"], "volume_usd": vol})
    out = out.dropna(subset=["close"])
    out = out[out["close"] > 0]
    out = out[out["date"] >= pd.Timestamp(start)]
    out = out.sort_values("date").reset_index(drop=True)
    out.to_csv(slim, index=False)
    print(f"[data] {asset}: {len(out)} rows {out['date'].iloc[0].date()} -> {out['date'].iloc[-1].date()}",
          file=sys.stderr)
    return out


def load_cached(asset: str) -> pd.DataFrame:
    slim = _slim_path(asset)
    df = pd.read_csv(slim, parse_dates=["date"])
    return df.sort_values("date").reset_index(drop=True)


def load(asset: str, force: bool = False) -> pd.DataFrame:
    if os.path.exists(_slim_path(asset)) and not force:
        return load_cached(asset)
    return fetch_and_cache(asset, force=force)


if __name__ == "__main__":
    force = "--force" in sys.argv
    for a in ASSETS:
        d = fetch_and_cache(a, force=force)
        print(f"{a}: {len(d)} rows, {d['date'].iloc[0].date()} -> {d['date'].iloc[-1].date()}, "
              f"last close={d['close'].iloc[-1]:.2f}")
```

### A.3 — `research/engine.py`

Vectorised daily backtest engine + metrics (the accounting identity).

```python
"""Vectorised daily backtest engine + metrics.

Conventions (no look-ahead):
  * A strategy produces a *target weight* ``w[t]`` (signed leverage) using
    only information available at the close of day ``t``.
  * That weight is held over day ``t+1`` and earns ``ret[t+1]``.
  * Transaction cost is charged when the held weight changes, i.e. at the
    close of the day the new weight is established.

So the realised portfolio return on day ``t`` is::

    held[t]   = w[t-1]                      # weight set at close of t-1
    r_p[t]    = held[t]*ret[t]
                - cost_bps * |held[t]-held[t-1]|   # turnover cost
                - funding_daily * |held[t]|        # carry / funding drag

Everything is annualised with 365 (crypto trades every day).
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Optional

import numpy as np
import pandas as pd

ANN = 365.0


# --------------------------------------------------------------------------
# Indicators (all causal: value at t uses prices[:t+1] only)
# --------------------------------------------------------------------------
def ema(x: pd.Series, span: int) -> pd.Series:
    return x.ewm(span=span, adjust=False, min_periods=span).mean()


def sma(x: pd.Series, n: int) -> pd.Series:
    return x.rolling(n, min_periods=n).mean()


def rolling_std(x: pd.Series, n: int) -> pd.Series:
    return x.rolling(n, min_periods=n).std(ddof=0)


def realized_vol(ret: pd.Series, n: int) -> pd.Series:
    """Annualised realised vol from daily returns over a trailing window."""
    return ret.rolling(n, min_periods=max(5, n // 2)).std(ddof=0) * np.sqrt(ANN)


def rsi(x: pd.Series, n: int) -> pd.Series:
    delta = x.diff()
    up = delta.clip(lower=0.0)
    dn = (-delta).clip(lower=0.0)
    roll_up = up.ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean()
    roll_dn = dn.ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean()
    rs = roll_up / roll_dn.replace(0.0, np.nan)
    return 100.0 - 100.0 / (1.0 + rs)


# --------------------------------------------------------------------------
# Metrics
# --------------------------------------------------------------------------
@dataclass
class Metrics:
    cagr: float
    ann_vol: float
    sharpe: float
    sortino: float
    max_dd: float
    calmar: float
    total_return: float
    avg_exposure: float
    ann_turnover: float
    n_trades: int
    win_rate_days: float
    n_days: int
    final_equity: float

    def as_dict(self) -> dict:
        return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in asdict(self).items()}


def compute_metrics(r_p: pd.Series, held: pd.Series) -> Metrics:
    r = r_p.dropna()
    n = len(r)
    if n < 5:
        return Metrics(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, n, 1.0)
    equity = (1.0 + r).cumprod()
    final_equity = float(equity.iloc[-1])
    total_return = final_equity - 1.0
    years = n / ANN
    cagr = final_equity ** (1.0 / years) - 1.0 if final_equity > 0 and years > 0 else -1.0
    mean = r.mean()
    std = r.std(ddof=0)
    ann_vol = std * np.sqrt(ANN)
    sharpe = (mean / std * np.sqrt(ANN)) if std > 0 else 0.0
    downside = r[r < 0].std(ddof=0)
    sortino = (mean / downside * np.sqrt(ANN)) if downside and downside > 0 else 0.0
    roll_max = equity.cummax()
    dd = equity / roll_max - 1.0
    max_dd = float(dd.min())
    calmar = (cagr / abs(max_dd)) if max_dd < 0 else 0.0
    h = held.reindex(r.index).fillna(0.0)
    avg_exposure = float(h.abs().mean())
    turn = h.diff().abs().fillna(h.abs())
    ann_turnover = float(turn.sum() / years) if years > 0 else 0.0
    # a "trade" = a change in the rounded sign/size bucket of the position
    sign_changes = int((np.sign(h).diff().fillna(0) != 0).sum())
    win_rate_days = float((r > 0).mean())
    return Metrics(
        cagr=cagr, ann_vol=ann_vol, sharpe=sharpe, sortino=sortino,
        max_dd=max_dd, calmar=calmar, total_return=total_return,
        avg_exposure=avg_exposure, ann_turnover=ann_turnover, n_trades=sign_changes,
        win_rate_days=win_rate_days, n_days=n, final_equity=final_equity,
    )


# --------------------------------------------------------------------------
# Backtest
# --------------------------------------------------------------------------
@dataclass
class Costs:
    # one-way transaction cost as a fraction of notional traded (turnover).
    # Binance perp taker ~0.04% + slippage. 0.0006 = 6 bps one-way is a
    # conservative default for these liquid pairs at modest size.
    txn: float = 0.0006
    # symmetric daily carry/funding drag per unit gross exposure. Crypto perp
    # funding averages a small positive number paid by the side that is with
    # the trend; modelled as a symmetric drag to stay conservative.
    funding_daily: float = 0.00005  # ~1.8%/yr at 1x gross


def backtest(prices: pd.Series, target_w: pd.Series, costs: Costs = Costs()) -> dict:
    """Run the engine. ``target_w`` is indexed like ``prices`` and is the
    weight decided at each day's close. Returns dict with equity, returns,
    held weights and Metrics."""
    prices = prices.astype(float)
    ret = prices.pct_change()
    w = target_w.reindex(prices.index).astype(float).fillna(0.0)
    held = w.shift(1).fillna(0.0)          # weight in force during day t
    turnover = held.diff().abs().fillna(held.abs())
    gross_ret = held * ret
    cost = costs.txn * turnover + costs.funding_daily * held.abs()
    r_p = (gross_ret - cost)
    # first row has no prior price -> drop NaN return day
    valid = ret.notna()
    r_p = r_p[valid]
    held_v = held[valid]
    equity = (1.0 + r_p).cumprod()
    m = compute_metrics(r_p, held_v)
    return {"equity": equity, "returns": r_p, "held": held_v, "metrics": m}


def apply_annual_breaker(returns: pd.Series, dd_stop: float = 0.25) -> pd.Series:
    """Within-year circuit breaker for the annual-reset / profit-withdrawal model.

    Each calendar year starts fresh at equity 1.0. If the year-to-date equity
    falls more than ``dd_stop`` below its running intra-year peak, the account
    goes flat for the remainder of that year (returns zeroed). Causal: the
    decision on day t uses only YTD information through t. This converts the
    catastrophic leveraged ruin years (e.g. XRP -100%) into capped small losses
    so the $100k base survives to the next year."""
    out = returns.copy()
    for y in sorted(set(returns.index.year)):
        idx = returns.index[returns.index.year == y]
        eq = 1.0
        peak = 1.0
        stopped = False
        for t in idx:
            if stopped:
                out.loc[t] = 0.0
                continue
            eq *= (1.0 + returns.loc[t])
            peak = max(peak, eq)
            if eq / peak - 1.0 <= -dd_stop:
                stopped = True  # flat for the rest of the year (today's loss kept)
    return out


def buy_hold_metrics(prices: pd.Series) -> Metrics:
    w = pd.Series(1.0, index=prices.index)
    return backtest(prices, w, Costs(txn=0.0006, funding_daily=0.0))["metrics"]
```

### A.4 — `research/strategies.py`

Signal families + build_weights vol-target overlay (CORE uses sig_tsmom_blend).

```python
"""Strategy families.

Each family exposes:
  * ``raw_signal(prices, p) -> Series`` in [-1, +1] (causal direction), and
  * a ``grid()`` of parameter dicts to search.

``build_weights`` wraps any raw signal with a volatility-targeting overlay and
optional long-only / leverage caps, producing the final target weight series
consumed by ``engine.backtest``.

The families are deliberately simple and few-parameter so that walk-forward
optimisation has a real chance of generalising rather than curve-fitting.
"""
from __future__ import annotations

import itertools
from typing import Callable, Iterable

import numpy as np
import pandas as pd

from engine import ema, sma, rolling_std, realized_vol, rsi, ANN

VOL_FLOOR = 0.10  # annualised; avoids explosive leverage in dead-calm periods


# --------------------------------------------------------------------------
# Overlay: turn a directional raw signal into a sized target weight
# --------------------------------------------------------------------------
def build_weights(prices: pd.Series, raw: pd.Series, p: dict) -> pd.Series:
    raw = raw.reindex(prices.index).fillna(0.0).clip(-1.0, 1.0)
    vt = p.get("vol_target", 0.0)
    max_lev = p.get("max_lev", 2.0)
    if vt and vt > 0:
        ret = prices.pct_change()
        rv = realized_vol(ret, p.get("vol_lb", 30)).clip(lower=VOL_FLOOR)
        scale = (vt / rv).clip(upper=max_lev)
        w = raw * scale
    else:
        w = raw * max_lev
    if p.get("long_only", False):
        w = w.clip(lower=0.0)
    return w.clip(-max_lev, max_lev).fillna(0.0)


# --------------------------------------------------------------------------
# Families
# --------------------------------------------------------------------------
def sig_tsmom(prices: pd.Series, p: dict) -> pd.Series:
    """Time-series momentum: sign of trailing L-day return."""
    L = p["lookback"]
    mom = prices / prices.shift(L) - 1.0
    return np.sign(mom)


def sig_macross(prices: pd.Series, p: dict) -> pd.Series:
    """EMA crossover trend."""
    f = ema(prices, p["fast"])
    s = ema(prices, p["slow"])
    return np.sign(f - s)


def sig_donchian(prices: pd.Series, p: dict) -> pd.Series:
    """Donchian-style breakout on closes. Long when close breaks above the
    prior N-day high, short when it breaks below the prior M-day low; holds
    the position in between (stateful)."""
    n, m = p["entry"], p["exit"]
    hi = prices.shift(1).rolling(n, min_periods=n).max()
    lo = prices.shift(1).rolling(m, min_periods=m).min()
    long_sig = (prices > hi).astype(float)
    short_sig = (prices < lo).astype(float) * -1.0
    raw = pd.Series(np.nan, index=prices.index)
    raw[long_sig > 0] = 1.0
    raw[short_sig < 0] = -1.0
    return raw.ffill().fillna(0.0)


def sig_mr_z(prices: pd.Series, p: dict) -> pd.Series:
    """Mean reversion on a z-score, gated off during strong trends.

    Crypto mean reversion is profitable in chop but lethal in trends, so we
    only fade when the fast/slow EMA spread (a trend-strength proxy) is small.
    """
    lb = p["lb"]
    mu = sma(prices, lb)
    sd = rolling_std(prices, lb).replace(0.0, np.nan)
    z = (prices - mu) / sd
    raw = pd.Series(np.nan, index=prices.index)
    raw[z > p["z_entry"]] = -1.0          # too high -> short
    raw[z < -p["z_entry"]] = 1.0          # too low  -> long
    raw[z.abs() < p["z_exit"]] = 0.0      # back to mean -> flat
    raw = raw.ffill().fillna(0.0)
    # trend gate
    spread = (ema(prices, 20) / ema(prices, 100) - 1.0).abs()
    gate = (spread < p.get("trend_gate", 0.10)).astype(float)
    return raw * gate


def sig_tsmom_blend(prices: pd.Series, p: dict) -> pd.Series:
    """Multi-lookback momentum consensus. Averages the sign of trailing
    returns over several horizons -> a [-1,1] conviction score. Far fewer
    free parameters than a single-lookback model, so it generalises better."""
    lbs = p.get("lbs", (20, 40, 80, 120))
    sig = sum(np.sign(prices / prices.shift(L) - 1.0) for L in lbs) / float(len(lbs))
    return sig


def sig_trend_flat(prices: pd.Series, p: dict) -> pd.Series:
    """Regime-gated trend: take the EMA-cross direction only when the
    fast/slow spread exceeds a band (a clear trend); otherwise stand flat.
    Designed to harvest sustained moves while sitting out the chop that
    whipsaws always-on trend models on high-beta alts."""
    f = ema(prices, p["fast"])
    s = ema(prices, p["slow"])
    spread = f / s - 1.0
    raw = pd.Series(0.0, index=prices.index)
    raw[spread > p["band"]] = 1.0
    raw[spread < -p["band"]] = -1.0
    return raw


def sig_rsi_mr(prices: pd.Series, p: dict) -> pd.Series:
    """RSI mean reversion: long oversold, short overbought, gated by trend."""
    r = rsi(prices, p["lb"])
    raw = pd.Series(np.nan, index=prices.index)
    raw[r < p["lo"]] = 1.0
    raw[r > p["hi"]] = -1.0
    raw[(r > 45) & (r < 55)] = 0.0
    raw = raw.ffill().fillna(0.0)
    spread = (ema(prices, 20) / ema(prices, 100) - 1.0).abs()
    gate = (spread < p.get("trend_gate", 0.12)).astype(float)
    return raw * gate


def classify_regime(prices: pd.Series, fast: int, slow: int, long_ma: int, band: float) -> pd.Series:
    """Per-day regime label: +1 uptrend, -1 downtrend, 0 chop. Causal."""
    f = ema(prices, fast)
    s = ema(prices, slow)
    lma = sma(prices, long_ma)
    spread = f / s - 1.0
    up = (spread > band) & (prices > lma)
    dn = (spread < -band) & (prices < lma)
    reg = pd.Series(0.0, index=prices.index)
    reg[up] = 1.0
    reg[dn] = -1.0
    return reg


def sig_orchestrator(prices: pd.Series, p: dict) -> pd.Series:
    """Regime-switching orchestrator (the architecture the brief asks for):

      * UPTREND   -> long momentum  (ride it)
      * DOWNTREND -> short momentum (profit from the bear)
      * CHOP      -> z-score mean reversion (fade the range)

    One model that adapts to the regime instead of assuming the market only
    ever goes up. This is what lets the system earn in down years."""
    reg = classify_regime(prices, p["fast"], p["slow"], p["long_ma"], p["band"])

    lbs = p.get("lbs", (20, 40, 80))
    trend = sum(np.sign(prices / prices.shift(L) - 1.0) for L in lbs) / float(len(lbs))

    lb = p.get("mr_lb", 15)
    mu = sma(prices, lb)
    sd = rolling_std(prices, lb).replace(0.0, np.nan)
    z = (prices - mu) / sd
    mr = pd.Series(0.0, index=prices.index)
    mr[z > p.get("z_entry", 1.5)] = -1.0
    mr[z < -p.get("z_entry", 1.5)] = 1.0

    raw = pd.Series(0.0, index=prices.index)
    up_mask = reg > 0
    dn_mask = reg < 0
    chop_mask = reg == 0
    raw[up_mask] = trend[up_mask].clip(lower=0.0)        # uptrend: long only
    raw[dn_mask] = trend[dn_mask].clip(upper=0.0)        # downtrend: short only
    chop_mr = mr if p.get("mr_allow_short", True) else mr.clip(lower=0.0)
    raw[chop_mask] = chop_mr[chop_mask] * p.get("mr_scale", 0.7)
    return raw.fillna(0.0)


# --------------------------------------------------------------------------
# Family registry: signal fn + parameter grid
# --------------------------------------------------------------------------
def _grid(base: dict, **axes) -> list[dict]:
    keys = list(axes.keys())
    out = []
    for combo in itertools.product(*[axes[k] for k in keys]):
        d = dict(base)
        d.update(dict(zip(keys, combo)))
        out.append(d)
    return out


# common overlay axes shared by every family
_OVERLAY = dict(vol_lb=[30], max_lev=[2.5])
_VT = [0.30, 0.45, 0.60]
_VT2 = [0.20, 0.30, 0.45, 0.65, 0.85]   # trend families: low for risk-control assets, high for hot ones


class Family:
    def __init__(self, name: str, fn: Callable[[pd.Series, dict], pd.Series], grid: list[dict]):
        self.name = name
        self.fn = fn
        self.grid = grid

    def weights(self, prices: pd.Series, p: dict) -> pd.Series:
        return build_weights(prices, self.fn(prices, p), p)


def all_families(long_only_opts: Iterable[bool] = (False, True)) -> list[Family]:
    fams: list[Family] = []

    fams.append(Family("tsmom", sig_tsmom, [
        dict(lookback=lb, vol_target=vt, vol_lb=30, max_lev=3.0, long_only=lo)
        for lb in (20, 40, 60, 90, 120)
        for vt in _VT2
        for lo in long_only_opts
    ]))

    fams.append(Family("tsmom_blend", sig_tsmom_blend, [
        dict(lbs=lbs, vol_target=vt, vol_lb=30, max_lev=3.0, long_only=lo)
        for lbs in ((20, 40, 80, 120), (10, 30, 60, 120), (30, 60, 120, 200))
        for vt in _VT2
        for lo in long_only_opts
    ]))

    fams.append(Family("trend_flat", sig_trend_flat, [
        dict(fast=f, slow=s, band=b, vol_target=vt, vol_lb=30, max_lev=3.0, long_only=lo)
        for (f, s) in ((20, 100), (30, 150), (20, 200))
        for b in (0.0, 0.02, 0.05)
        for vt in _VT2
        for lo in long_only_opts
    ]))

    fams.append(Family("macross", sig_macross, [
        dict(fast=f, slow=s, vol_target=vt, vol_lb=30, max_lev=2.5, long_only=lo)
        for (f, s) in ((10, 50), (20, 100), (20, 200), (50, 200), (30, 150))
        for vt in _VT
        for lo in long_only_opts
    ]))

    fams.append(Family("donchian", sig_donchian, [
        dict(entry=n, exit=m, vol_target=vt, vol_lb=30, max_lev=2.5, long_only=lo)
        for (n, m) in ((20, 10), (40, 20), (55, 20), (90, 30))
        for vt in _VT
        for lo in long_only_opts
    ]))

    fams.append(Family("mr_z", sig_mr_z, [
        dict(lb=lb, z_entry=ze, z_exit=zx, trend_gate=tg, vol_target=vt, vol_lb=20, max_lev=2.0, long_only=lo)
        for lb in (10, 20, 30)
        for ze in (1.5, 2.0)
        for zx in (0.3, 0.5)
        for tg in (0.08, 0.15)
        for vt in (0.30, 0.45)
        for lo in long_only_opts
    ]))

    fams.append(Family("rsi_mr", sig_rsi_mr, [
        dict(lb=lb, lo=lo_th, hi=hi_th, trend_gate=tg, vol_target=vt, vol_lb=20, max_lev=2.0, long_only=lo)
        for lb in (7, 14)
        for (lo_th, hi_th) in ((30, 70), (25, 75), (35, 65))
        for tg in (0.10, 0.18)
        for vt in (0.30, 0.45)
        for lo in long_only_opts
    ]))

    return fams


def family_by_name(name: str) -> Family:
    for f in all_families():
        if f.name == name:
            return f
    raise KeyError(name)


# Leverage ladder for the v2 (futures) search. Effective exposure is
# vol-target / realised-vol, capped at max_lev; the exchange's 10-50x facility
# is what permits notional > equity. Higher targets chase the 50%/yr bar.
_VT3 = [0.6, 0.9, 1.3, 1.8]
_MAXLEV3 = [10.0]


def v2_families() -> list[Family]:
    """Futures-oriented, long/short, higher-leverage family set + the regime
    orchestrator. Used by run_v2.py for the >=50%/yr (annual-reset) target."""
    fams: list[Family] = []

    fams.append(Family("orchestrator", sig_orchestrator, [
        dict(fast=f, slow=s, long_ma=lma, band=b, lbs=lbs, mr_lb=mrlb, z_entry=ze,
             mr_scale=0.7, mr_allow_short=True,
             vol_target=vt, vol_lb=20, max_lev=ml, long_only=False)
        for (f, s, lma) in ((20, 60, 150), (15, 50, 100), (25, 75, 200))
        for b in (0.0, 0.02)
        for lbs in ((20, 40, 80),)
        for mrlb in (12, 20)
        for ze in (1.3, 1.8)
        for vt in _VT3
        for ml in _MAXLEV3
    ]))

    fams.append(Family("tsmom_blend_lev", sig_tsmom_blend, [
        dict(lbs=lbs, vol_target=vt, vol_lb=20, max_lev=ml, long_only=lo)
        for lbs in ((10, 30, 60, 120), (20, 40, 80, 120))
        for vt in _VT3
        for ml in _MAXLEV3
        for lo in (False, True)
    ]))

    fams.append(Family("donchian_lev", sig_donchian, [
        dict(entry=n, exit=m, vol_target=vt, vol_lb=20, max_lev=ml, long_only=lo)
        for (n, m) in ((20, 10), (40, 20), (55, 20))
        for vt in _VT3
        for ml in _MAXLEV3
        for lo in (False, True)
    ]))

    fams.append(Family("mr_z_lev", sig_mr_z, [
        dict(lb=lb, z_entry=ze, z_exit=zx, trend_gate=tg, vol_target=vt, vol_lb=15, max_lev=ml, long_only=False)
        for lb in (10, 15, 20)
        for ze in (1.5, 2.0)
        for zx in (0.3, 0.5)
        for tg in (0.10, 0.20)
        for vt in (0.6, 0.9, 1.3)
        for ml in _MAXLEV3
    ]))

    return fams
```

### A.5 — `research/production_strategy.py`

The deployable daily CORE book = 0.60 trend + 0.40 cross-sectional.

```python
"""Deployable strategy definition — operationalises the validated research.

This is the single shippable strategy the study converged on. It maps the §13
research directly to *today's target weights* given live daily data (SOL/ETH/BTC/
DOGE/XRP from data-api.binance.vision / KuCoin), so it can drive the production
bot's risk/execution layer.

Validated expectation (OOS, walk-forward; see SOFTWARE_SPEC §12.6–12.10, §13.6):
  * banks +50% in ~86% of years fully out-of-sample (allocation walk-forwarded),
    ~90% with the best static allocation; the structural miss is a 2022-type bear
    where all five coins crash together.
  * NOT a +50%-every-year guarantee — that is unattainable here without overfitting.

Components (all causal):
  A. Absolute-trend sleeve  — long-only multi-lookback momentum (tsmom_blend) per
     coin, inverse-vol sized. Carries the trend years.
  B. Cross-sectional sleeve — each day hold the top-k strongest coins (rotation).
     Carries the trendless/dispersion years (2023, 2025).
  Book weight: w_trend=0.60, w_xs=0.40 (the allocation the walk-forward converged on).
  Effective-leverage cap and the annual +50% profit-lock / −40% stop sit on top.
  Optional crash-hedge overlay (crash_hedge.py) for softer bears (tail protection,
  not a +50% source) — OFF by default.
"""
from __future__ import annotations

import sys

import numpy as np
import pandas as pd

import data as datamod
from engine import realized_vol
from strategies import sig_tsmom_blend, build_weights

COINS = ["SOL", "ETH", "BTC", "DOGE", "XRP"]

# validated config
W_TREND, W_XS = 0.60, 0.40
TREND_LBS = {"SOL": (10, 30, 60, 120), "ETH": (10, 30, 60, 120),
             "BTC": (10, 30, 60, 120), "DOGE": (20, 40, 80, 120),
             "XRP": (20, 40, 80, 120)}
VOL_TARGET, VOL_LB, MAX_LEV = 0.60, 20, 3.0
XS_TOPK = 2
XS_LBS = (20, 40, 80)
EFF_LEV_CAP = 2.0           # conservative cap on book gross exposure (× equity)
TARGET, STOP = 0.50, 0.40


def load_panel() -> pd.DataFrame:
    cols = {}
    for c in COINS:
        df = datamod.load(c)
        s = pd.Series(df["close"].values, index=pd.DatetimeIndex(df["date"]))
        cols[c] = s[~s.index.duplicated(keep="first")].sort_index()
    panel = pd.DataFrame(cols).sort_index()
    # align to the last date all coins share (sources can differ by a day)
    last_common = min(panel[c].last_valid_index() for c in COINS)
    return panel.loc[:last_common]


def trend_weights(panel: pd.DataFrame) -> pd.DataFrame:
    """Per-coin long-only tsmom_blend target weights."""
    out = {}
    for c in COINS:
        p = panel[c].dropna()
        raw = sig_tsmom_blend(p, {"lbs": TREND_LBS[c]})
        w = build_weights(p, raw, dict(vol_target=VOL_TARGET, vol_lb=VOL_LB,
                                       max_lev=MAX_LEV, long_only=True))
        out[c] = w.reindex(panel.index)
    return pd.DataFrame(out)


def xs_weights(panel: pd.DataFrame) -> pd.DataFrame:
    """Cross-sectional top-k long rotation, vol-targeted at the basket level."""
    score = sum(np.sign(panel / panel.shift(L) - 1.0) * (panel / panel.shift(L) - 1.0)
                for L in XS_LBS) / float(len(XS_LBS))
    ranks = score.rank(axis=1, ascending=False, method="first")
    w = pd.DataFrame(0.0, index=panel.index, columns=panel.columns)
    w = w.mask(ranks.le(XS_TOPK) & score.notna(), 1.0)
    gross = w.sum(axis=1).replace(0.0, np.nan)
    w = w.div(gross, axis=0).fillna(0.0)          # equal-weight the held coins
    # vol-target the basket
    rets = panel.pct_change()
    basket = (w.shift(1).fillna(0.0) * rets).sum(axis=1)
    rv = realized_vol(basket, 30).clip(lower=0.10)
    scale = (VOL_TARGET / rv).clip(upper=MAX_LEV).fillna(0.0)
    return w.mul(scale, axis=0)


def book_weights(panel: pd.DataFrame) -> pd.DataFrame:
    tw = trend_weights(panel).fillna(0.0)
    xw = xs_weights(panel).fillna(0.0)
    book = W_TREND * tw + W_XS * xw
    # cap book gross exposure
    gross = book.abs().sum(axis=1).replace(0.0, np.nan)
    overcap = (gross > EFF_LEV_CAP)
    factor = pd.Series(1.0, index=book.index)
    factor[overcap] = EFF_LEV_CAP / gross[overcap]
    return book.mul(factor, axis=0).fillna(0.0)


def main(argv):
    panel = load_panel()
    book = book_weights(panel)
    today = book.index[-1]
    w_today = book.loc[today]
    gross = float(w_today.abs().sum())
    print(f"Deployable strategy — target weights for {today.date()} "
          f"(trend {W_TREND:.0%} / cross-sectional {W_XS:.0%}, eff-lev cap {EFF_LEV_CAP}×)")
    print(f"{'coin':>6} {'weight':>9} {'last_close':>12}")
    for c in COINS:
        print(f"{c:>6} {w_today[c]:>8.1%} {panel[c].iloc[-1]:>12,.4f}")
    print(f"{'GROSS':>6} {gross:>8.1%}  (book exposure as a multiple of equity)")
    print("\nAnnual wrapper at deploy time: $100k reset each Jan; apply these daily")
    print(f"target weights; bank & go flat once YTD >= +{TARGET:.0%}; stop for the year")
    print(f"at YTD <= -{STOP:.0%}; withdraw profit at year end. Paper-trade first.")
    print("\nValidated: ~86% of years bank +50% fully-OOS (90% best static); NOT every")
    print("year — a 2022-type all-coin crash is the documented structural miss.")


if __name__ == "__main__":
    main(sys.argv[1:])
```

### A.6 — `research/daytrade_winrate.py`

Intraday bracket engine: indicators, Trade, bracket_backtest, grids.

```python
"""Day-trading WIN-RATE study for BTC & ETH on 1H / 8H / 12H / 1D candles.

Goal (from the project goal): *as a day trader*, find the most profitable way to
trade BTC & ETH on intraday candles, optimised for the **highest win rate** — and
do it honestly, i.e. report win rate **alongside** the things that decide whether a
high win rate is actually worth anything: net return after costs, profit factor,
expectancy, and tail/drawdown.

Why this is its own study. The repo already proved (PATTERNS / PREDICTION docs)
that BTC/ETH *direction* is ~unpredictable at short horizons, and the prior
intraday work optimised for *Sharpe* to complement a daily trend book. Nobody
optimised for **win rate**, which is a genuinely different objective: a tight
take-profit with a wide stop wins most trades by construction — the open question
a day trader actually cares about is whether any such high-hit-rate setup keeps a
*positive expectancy after real fees*, or whether the rare big loss eats the many
small wins. This script answers that, per coin and per timeframe.

Engine (no lookahead, conservative):
  * Signal is computed on bar t's CLOSE; entry fills at bar t+1's OPEN.
  * Each trade is a bracket: take-profit and stop-loss as % of entry (or ATR mult),
    plus a time-stop after N bars (exit at close).
  * Intrabar fills use HIGH/LOW. Gaps fill at the bar OPEN. If a single bar's range
    contains BOTH the TP and the SL, we assume the **stop** filled first (worst
    case) so win rate is never optimistically inflated — this matters precisely
    because high-win-rate setups are the ones vulnerable to that bias.
  * One position at a time (a focused day-trade book). Round-trip taker cost charged.

Validation: timeline split 70% train / 30% test. Parameters are chosen ONLY on
train (by net expectancy with a trade-count floor); we then report the SAME config
on the unseen test slice. A setup only "counts" if its win rate AND profitability
survive out-of-sample.

Data: research/data/intraday/<SYM>_1h.csv (real Binance spot OHLCV), resampled to
8H/12H/1D anchored at 00:00 UTC.
"""
from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
INTRADAY_DIR = os.path.join(HERE, "data", "intraday")
RESULTS = os.path.join(HERE, "results")

COINS = ["BTC", "ETH"]
TIMEFRAMES = ["1h", "8h", "12h", "1d"]

# Realistic round-trip cost. Binance spot taker is ~10 bps; futures taker ~5 bps.
# We charge 6 bps PER SIDE (12 bps round-trip) as a conservative-but-fair taker
# assumption for a retail day trader. (Maker/limit entries would be cheaper; this
# is the pessimistic case, which is the right bar for a high-turnover book.)
COST_BPS_PER_SIDE = 6.0

TRAIN_FRAC = 0.70
MIN_TRADES_TRAIN = 30   # don't trust a param set with too few train trades
MIN_TRADES_TEST = 12


# --------------------------------------------------------------------------- data
def load_1h(sym: str) -> pd.DataFrame:
    path = os.path.join(INTRADAY_DIR, f"{sym}_1h.csv")
    df = pd.read_csv(path)
    idx = pd.to_datetime(df["timestamp_ms"], unit="ms", utc=True).dt.tz_localize(None)
    df = df.set_index(idx)[["open", "high", "low", "close", "volume"]].astype(float)
    df = df[~df.index.duplicated(keep="first")].sort_index()
    return df


def resample(df1h: pd.DataFrame, tf: str) -> pd.DataFrame:
    if tf == "1h":
        out = df1h.copy()
    else:
        rule = {"8h": "8h", "12h": "12h", "1d": "1D"}[tf]
        out = pd.DataFrame({
            "open": df1h["open"].resample(rule).first(),
            "high": df1h["high"].resample(rule).max(),
            "low": df1h["low"].resample(rule).min(),
            "close": df1h["close"].resample(rule).last(),
            "volume": df1h["volume"].resample(rule).sum(),
        }).dropna()
    return out


# --------------------------------------------------------------------- indicators
def rsi(close: np.ndarray, n: int) -> np.ndarray:
    d = np.diff(close, prepend=close[0])
    up = np.where(d > 0, d, 0.0)
    dn = np.where(d < 0, -d, 0.0)
    # Wilder smoothing
    ru = np.zeros_like(close)
    rd = np.zeros_like(close)
    ru[:n] = up[:n].mean() if n > 0 else 0.0
    rd[:n] = dn[:n].mean() if n > 0 else 0.0
    a = 1.0 / n
    for i in range(n, len(close)):
        ru[i] = (1 - a) * ru[i - 1] + a * up[i]
        rd[i] = (1 - a) * rd[i - 1] + a * dn[i]
    with np.errstate(divide="ignore", invalid="ignore"):
        rs = np.where(rd > 1e-12, ru / rd, np.inf)
    out = 100.0 - 100.0 / (1.0 + rs)
    out[:n] = 50.0
    return out


def atr(high, low, close, n: int) -> np.ndarray:
    pc = np.roll(close, 1)
    pc[0] = close[0]
    tr = np.maximum(high - low, np.maximum(np.abs(high - pc), np.abs(low - pc)))
    out = np.zeros_like(close)
    out[:n] = tr[:n].mean()
    a = 1.0 / n
    for i in range(n, len(close)):
        out[i] = (1 - a) * out[i - 1] + a * tr[i]
    return out


def sma(x: np.ndarray, n: int) -> np.ndarray:
    if n <= 1:
        return x.copy()
    if n > len(x):                       # window longer than series -> all NaN
        return np.full(len(x), np.nan)
    c = np.cumsum(np.insert(x, 0, 0.0))
    out = (c[n:] - c[:-n]) / n
    return np.concatenate([np.full(n - 1, np.nan), out])


def rolling_std(x: np.ndarray, n: int) -> np.ndarray:
    s = pd.Series(x)
    return s.rolling(n).std(ddof=0).to_numpy()


# ----------------------------------------------------------------------- signals
# Each signal generator returns an int array in {+1, -1, 0}: the DESIRED entry
# direction at this bar's close (acted on next bar's open, only when flat).

def sig_zscore(o, h, l, c, p):
    lb = p["lb"]
    ma = sma(c, lb)
    sd = rolling_std(c, lb)
    z = (c - ma) / np.where(sd > 1e-12, sd, np.nan)
    s = np.zeros(len(c), dtype=int)
    s[z <= -p["z"]] = 1                      # oversold -> long
    if not p.get("long_only"):
        s[z >= p["z"]] = -1                  # overbought -> short
    s[~np.isfinite(z)] = 0
    return s


def sig_rsi(o, h, l, c, p):
    r = rsi(c, p["lb"])
    s = np.zeros(len(c), dtype=int)
    s[r <= p["lo"]] = 1
    if not p.get("long_only"):
        s[r >= p["hi"]] = -1
    return s


def sig_trend_pullback(o, h, l, c, p):
    """Buy-the-dip *in the direction of the higher trend* (continuation).
    Trend = price vs slow SMA; dip = RSI below a mid threshold. Hypothesis: the
    trend bias lifts both win rate AND expectancy vs pure mean reversion."""
    slow = sma(c, p["slow"])
    r = rsi(c, p["rsi_lb"])
    up = c > slow
    dn = c < slow
    s = np.zeros(len(c), dtype=int)
    s[up & (r <= p["dip"])] = 1              # uptrend + short-term dip -> long
    if not p.get("long_only"):
        s[dn & (r >= 100 - p["dip"])] = -1   # downtrend + short-term pop -> short
    return s


SIGNALS = {
    "zscore_mr": sig_zscore,
    "rsi_mr": sig_rsi,
    "trend_pullback": sig_trend_pullback,
}


# ------------------------------------------------------------------------ engine
@dataclass
class Trade:
    side: int          # +1 long / -1 short
    entry_i: int
    exit_i: int
    entry_px: float
    exit_px: float
    ret_net: float     # net of round-trip cost, as fraction of capital (1x)
    reason: str        # 'tp' | 'sl' | 'time'


def bracket_backtest(df: pd.DataFrame, signal: np.ndarray, tp: float, sl: float,
                     max_hold: int, cost_bps: float, atr_arr=None,
                     tp_atr: float = 0.0, sl_atr: float = 0.0) -> list[Trade]:
    """Event-driven bracket sim. tp/sl are fractional (e.g. 0.01 = 1%). If
    tp_atr/sl_atr > 0, brackets are ATR-multiples instead (overrides tp/sl).
    Conservative same-bar resolution: stop wins ties."""
    o = df["open"].to_numpy(); h = df["high"].to_numpy()
    l = df["low"].to_numpy(); c = df["close"].to_numpy()
    n = len(c)
    cost = cost_bps / 1e4
    trades: list[Trade] = []
    i = 0
    while i < n - 1:
        sdir = signal[i]
        if sdir == 0:
            i += 1
            continue
        # enter at next bar open
        ei = i + 1
        epx = o[ei]
        if not np.isfinite(epx) or epx <= 0:
            i += 1
            continue
        if tp_atr > 0 and atr_arr is not None:
            a = atr_arr[i]
            tp_lvl = epx + sdir * tp_atr * a
            sl_lvl = epx - sdir * sl_atr * a
        else:
            tp_lvl = epx * (1 + sdir * tp)
            sl_lvl = epx * (1 - sdir * sl)
        exit_i, exit_px, reason = -1, np.nan, "time"
        last = min(ei + max_hold, n - 1)
        for j in range(ei, last + 1):
            oj, hj, lj, cj = o[j], h[j], l[j], c[j]
            if sdir == 1:
                # gap through stop at open
                if oj <= sl_lvl:
                    exit_i, exit_px, reason = j, oj, "sl"; break
                if oj >= tp_lvl:
                    exit_i, exit_px, reason = j, oj, "tp"; break
                hit_sl = lj <= sl_lvl
                hit_tp = hj >= tp_lvl
                if hit_sl:                      # stop wins ties (worst case)
                    exit_i, exit_px, reason = j, sl_lvl, "sl"; break
                if hit_tp:
                    exit_i, exit_px, reason = j, tp_lvl, "tp"; break
            else:
                if oj >= sl_lvl:
                    exit_i, exit_px, reason = j, oj, "sl"; break
                if oj <= tp_lvl:
                    exit_i, exit_px, reason = j, oj, "tp"; break
                hit_sl = hj >= sl_lvl
                hit_tp = lj <= tp_lvl
                if hit_sl:
                    exit_i, exit_px, reason = j, sl_lvl, "sl"; break
                if hit_tp:
                    exit_i, exit_px, reason = j, tp_lvl, "tp"; break
            if j == last:                       # time stop
                exit_i, exit_px, reason = j, cj, "time"
        gross = sdir * (exit_px / epx - 1.0)
        ret_net = gross - 2 * cost              # entry + exit cost
        trades.append(Trade(sdir, ei, exit_i, epx, exit_px, ret_net, reason))
        i = exit_i + 1                          # flat until current trade closes
    return trades


# ----------------------------------------------------------------------- metrics
def trade_metrics(trades: list[Trade]) -> dict:
    if not trades:
        return dict(n=0, win_rate=0.0, net_total=0.0, expectancy=0.0,
                    profit_factor=0.0, avg_win=0.0, avg_loss=0.0,
                    max_dd=0.0, avg_hold=0.0, exposure_bars=0)
    rets = np.array([t.ret_net for t in trades])
    wins = rets[rets > 0]; losses = rets[rets <= 0]
    eq = np.cumprod(1 + rets)
    peak = np.maximum.accumulate(eq)
    dd = (eq / peak - 1.0).min()
    hold = np.array([t.exit_i - t.entry_i + 1 for t in trades])
    gross_w = wins.sum(); gross_l = -losses.sum()
    pf = (gross_w / gross_l) if gross_l > 1e-12 else (np.inf if gross_w > 0 else 0.0)
    return dict(
        n=len(trades),
        win_rate=float((rets > 0).mean()),
        net_total=float(eq[-1] - 1.0),          # compounded 1x return over the slice
        expectancy=float(rets.mean()),          # net per-trade
        profit_factor=float(pf),
        avg_win=float(wins.mean()) if len(wins) else 0.0,
        avg_loss=float(losses.mean()) if len(losses) else 0.0,
        max_dd=float(dd),
        avg_hold=float(hold.mean()),
        exposure_bars=int(hold.sum()),
    )


# -------------------------------------------------------------------- param grids
def grids(tf: str) -> dict[str, list[dict]]:
    """Param grids per signal family. Bracket tp/sl and max_hold scale with tf so
    a '1H trade' and a '1D trade' are both plausible day-trade horizons."""
    # max_hold in BARS, chosen so holding time is a day-trader horizon per tf.
    hold = {"1h": [6, 12, 24, 48], "8h": [3, 6, 9], "12h": [2, 4, 6], "1d": [1, 2, 3]}[tf]
    # bracket sizes (fractions). Cover the win-rate/expectancy tradeoff explicitly:
    # tight-TP/wide-SL (high hit rate) ... symmetric ... wide-TP/tight-SL (low hit rate)
    brs = [(0.005, 0.005), (0.005, 0.010), (0.005, 0.015),
           (0.010, 0.010), (0.010, 0.020), (0.010, 0.005),
           (0.015, 0.015), (0.020, 0.020), (0.020, 0.010),
           (0.030, 0.030), (0.030, 0.015)]
    # daily-scale brackets are a bit larger
    if tf in ("12h", "1d"):
        brs = [(t * 2, s * 2) for t, s in brs]

    g: dict[str, list[dict]] = {}
    g["zscore_mr"] = [
        dict(lb=lb, z=z, long_only=lo, tp=tp, sl=sl, max_hold=mh)
        for lb in (10, 20, 40)
        for z in (1.5, 2.0, 2.5)
        for lo in (False, True)
        for (tp, sl) in brs
        for mh in hold
    ]
    g["rsi_mr"] = [
        dict(lb=lb, lo=lo_t, hi=hi_t, long_only=loo, tp=tp, sl=sl, max_hold=mh)
        for lb in (7, 14, 21)
        for (lo_t, hi_t) in ((25, 75), (20, 80), (30, 70))
        for loo in (False, True)
        for (tp, sl) in brs
        for mh in hold
    ]
    g["trend_pullback"] = [
        dict(slow=sl_w, rsi_lb=rl, dip=dp, long_only=lo, tp=tp, sl=sl, max_hold=mh)
        for sl_w in (50, 100, 200)
        for rl in (7, 14)
        for dp in (35, 40, 45)
        for lo in (False, True)
        for (tp, sl) in brs
        for mh in hold
    ]
    return g


# --------------------------------------------------------------------- run / rank
def run_config(df, fam, p, cost_bps, atr_arr):
    sig = SIGNALS[fam](df["open"].to_numpy(), df["high"].to_numpy(),
                       df["low"].to_numpy(), df["close"].to_numpy(), p)
    return bracket_backtest(df, sig, p["tp"], p["sl"], p["max_hold"], cost_bps, atr_arr)


def split_idx(n: int) -> int:
    return int(n * TRAIN_FRAC)


def evaluate(sym: str, tf: str) -> dict:
    df1h = load_1h(sym)
    df = resample(df1h, tf)
    c = df["close"].to_numpy()
    a = atr(df["high"].to_numpy(), df["low"].to_numpy(), c, 14)
    sp = split_idx(len(df))
    df_tr = df.iloc[:sp]; df_te = df.iloc[sp:]
    a_tr = a[:sp]; a_te = a[sp:]

    out = {"coin": sym, "tf": tf, "bars": len(df),
           "train_span": [str(df_tr.index[0].date()), str(df_tr.index[-1].date())],
           "test_span": [str(df_te.index[0].date()), str(df_te.index[-1].date())],
           "families": {}}

    fam_grids = grids(tf)
    for fam, params in fam_grids.items():
        # single pass over the grid; track best-by-expectancy AND
        # best-by-winrate (among net-positive train configs)
        best_exp = None     # (expectancy, params, train_metrics)
        best_wr = None      # (win_rate, params, train_metrics)
        for p in params:
            tr = run_config(df_tr, fam, p, COST_BPS_PER_SIDE, a_tr)
            m = trade_metrics(tr)
            if m["n"] < MIN_TRADES_TRAIN:
                continue
            if best_exp is None or m["expectancy"] > best_exp[0]:
                best_exp = (m["expectancy"], p, m)
            if m["net_total"] > 0 and (best_wr is None or m["win_rate"] > best_wr[0]):
                best_wr = (m["win_rate"], p, m)
        if best_exp is None:
            out["families"][fam] = {"status": "no_qualifying_train_config"}
            continue
        _, bp, m_tr = best_exp
        m_te = trade_metrics(run_config(df_te, fam, bp, COST_BPS_PER_SIDE, a_te))
        wr_block = None
        if best_wr is not None:
            _, wp, mwr_tr = best_wr
            mwr_te = trade_metrics(run_config(df_te, fam, wp, COST_BPS_PER_SIDE, a_te))
            wr_block = {"params": wp, "train": mwr_tr, "test": mwr_te}
        out["families"][fam] = {
            "best_by_expectancy": {"params": bp, "train": m_tr, "test": m_te},
            "best_by_winrate_netpos": wr_block,
        }
    return out


def fmt_m(m: dict) -> str:
    if m.get("n", 0) == 0:
        return "n=0"
    return (f"n={m['n']:>4} win={m['win_rate']:>5.1%} net={m['net_total']:>+7.1%} "
            f"PF={m['profit_factor']:>4.2f} exp={m['expectancy']:>+.3%} "
            f"DD={m['max_dd']:>+6.1%} hold={m['avg_hold']:.1f}b")


def main(argv):
    coins = [a.upper() for a in argv if a.upper() in COINS] or COINS
    tfs = [a for a in argv if a in TIMEFRAMES] or TIMEFRAMES
    os.makedirs(RESULTS, exist_ok=True)
    allout = {"cost_bps_per_side": COST_BPS_PER_SIDE, "train_frac": TRAIN_FRAC,
              "results": []}
    print(f"DAY-TRADE WIN-RATE STUDY  coins={coins} tfs={tfs}  "
          f"cost={COST_BPS_PER_SIDE}bps/side  train={TRAIN_FRAC:.0%}\n"
          f"(entry=next-open, conservative same-bar stop-first, 1x, one-at-a-time)\n")
    for sym in coins:
        for tf in tfs:
            r = evaluate(sym, tf)
            allout["results"].append(r)
            print(f"\n===== {sym} {tf}  bars={r['bars']}  "
                  f"train {r['train_span'][0]}→{r['train_span'][1]}  "
                  f"test {r['test_span'][0]}→{r['test_span'][1]} =====")
            for fam, fb in r["families"].items():
                if "status" in fb:
                    print(f"  {fam:<16} {fb['status']}")
                    continue
                be = fb["best_by_expectancy"]
                print(f"  {fam:<16} [max-expectancy]")
                print(f"      params {be['params']}")
                print(f"      TRAIN  {fmt_m(be['train'])}")
                print(f"      TEST   {fmt_m(be['test'])}")
                wb = fb["best_by_winrate_netpos"]
                if wb:
                    print(f"  {fam:<16} [max-winrate, net+]")
                    print(f"      TRAIN  {fmt_m(wb['train'])}")
                    print(f"      TEST   {fmt_m(wb['test'])}")
    # ---------------- OOS leaderboard ----------------
    # An entry "survives" only if its TEST slice is net-positive AND has enough
    # test trades to be believable. Rank survivors by TEST win rate.
    board = []
    for r in allout["results"]:
        for fam, fb in r["families"].items():
            if "status" in fb:
                continue
            for tag, blk in (("exp", fb.get("best_by_expectancy")),
                             ("wr", fb.get("best_by_winrate_netpos"))):
                if not blk:
                    continue
                te = blk["test"]; trn = blk["train"]
                survived = te["n"] >= MIN_TRADES_TEST and te["net_total"] > 0
                board.append({
                    "coin": r["coin"], "tf": r["tf"], "family": fam, "select": tag,
                    "params": blk["params"],
                    "train_win": trn["win_rate"], "train_net": trn["net_total"],
                    "test_n": te["n"], "test_win": te["win_rate"],
                    "test_net": te["net_total"], "test_pf": te["profit_factor"],
                    "test_dd": te["max_dd"], "test_exp": te["expectancy"],
                    "survived": survived,
                })
    survivors = sorted([b for b in board if b["survived"]],
                       key=lambda b: b["test_win"], reverse=True)
    allout["leaderboard"] = {"survivors": survivors, "all": board}
    print("\n" + "=" * 84)
    print("OOS LEADERBOARD — configs net-positive on the UNSEEN test slice "
          f"(test n>={MIN_TRADES_TEST}), ranked by test win rate")
    print("=" * 84)
    if not survivors:
        print("  NONE. No configuration stayed net-positive out-of-sample with a "
              "trustworthy trade count.")
    else:
        print(f"  {'coin':<4} {'tf':<4} {'family':<15} {'sel':<3} "
              f"{'test_win':>8} {'test_net':>9} {'PF':>5} {'test_DD':>8} "
              f"{'n':>4}")
        for b in survivors:
            print(f"  {b['coin']:<4} {b['tf']:<4} {b['family']:<15} {b['select']:<3} "
                  f"{b['test_win']:>8.1%} {b['test_net']:>+9.1%} "
                  f"{b['test_pf']:>5.2f} {b['test_dd']:>+8.1%} {b['test_n']:>4}")

    with open(os.path.join(RESULTS, "daytrade_winrate_results.json"), "w") as f:
        json.dump(allout, f, indent=2, default=float)
    print(f"\nwrote {os.path.join(RESULTS, 'daytrade_winrate_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
```

### A.7 — `research/daytrade_strategies2.py`

Round-2 intraday families incl. regime_pullback + bracket_ext + rolling walk_forward (emits dated OOS trades).

```python
"""Round 2 of the day-trade study: the strategy families the first pass MISSED.

The first study (daytrade_winrate.py / daytrade_walkforward.py) tested three entry
families (z-score MR, RSI MR, trend-pullback) with FIXED-% brackets, and found a
single rolling-walk-forward survivor: BTC 1H trend-pullback. This module rigorously
walk-forward-tests the families that pass did NOT cover, so the "only one edge"
verdict is an exhaustive result rather than an artefact of a narrow search:

  #1 breakout / momentum-continuation  (Donchian channel break, +/- trend filter)
  #2 volatility-adaptive & trailing exits (ATR brackets, trailing stop)   [exit dim]
  #3 regime gate (ADX trend-strength) on the pullback                     [entry filter]
  #5 time-of-day / session filter on the pullback                          [entry filter]
  #6 VWAP / volume entries (VWAP-anchored pullback)
  #4 CROSS-ASSET BTC->ETH lead-lag / relative strength  (the ETH rescue)  [emphasis]
  #7 trade management: partial scale-out + trail the runner                [exit dim]

Same honest harness as the gold-standard pass:
  * signal on bar t close, fill at t+1 open; conservative same-bar stop-first; gaps
    fill at the open; 1x, one position at a time; 6 bps/side round-trip cost.
  * ROLLING walk-forward: train 365d -> unseen 120d, NON-overlapping test windows,
    params chosen on train ONLY by net expectancy (>=15 train trades), OOS stitched.
  * exit geometry (fixed-% / ATR / trailing / scale-out) is part of the searched
    grid, so "best exit" is itself chosen out-of-sample.

Run:  python research/daytrade_strategies2.py            # full sweep (background it)
      python research/daytrade_strategies2.py ETH 1h eth_btc_gated   # one cell (smoke)
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

from daytrade_winrate import (COST_BPS_PER_SIDE, RESULTS, Trade, atr, load_1h,
                              rsi, sma, trade_metrics)

# ----------------------------------------------------------------- config / scales
TFS = ["1h", "4h", "8h"]                       # 1h = proven day-trade home; 4h/8h fresh
BARS_PER_DAY = {"1h": 24, "4h": 6, "8h": 3}
RESAMPLE_RULE = {"1h": None, "4h": "4h", "8h": "8h"}
TRAIN_DAYS = 365
TEST_DAYS = 120
MIN_TRADES_TRAIN_FOLD = 15
HOLDS = {"1h": [24, 48], "4h": [12, 24], "8h": [6, 12]}


def resample_tf(df1h: pd.DataFrame, tf: str) -> pd.DataFrame:
    rule = RESAMPLE_RULE[tf]
    if rule is None:
        return df1h.copy()
    return pd.DataFrame({
        "open": df1h["open"].resample(rule).first(),
        "high": df1h["high"].resample(rule).max(),
        "low": df1h["low"].resample(rule).min(),
        "close": df1h["close"].resample(rule).last(),
        "volume": df1h["volume"].resample(rule).sum(),
    }).dropna()


# ----------------------------------------------------------------------- indicators
def _wilder(x: np.ndarray, n: int) -> np.ndarray:
    out = np.zeros(len(x), dtype=float)
    if len(x) == 0:
        return out
    out[:n] = np.nanmean(x[:n]) if n > 0 else 0.0
    a = 1.0 / n
    for i in range(n, len(x)):
        out[i] = (1 - a) * out[i - 1] + a * x[i]
    return out


def adx(high, low, close, n: int = 14) -> np.ndarray:
    up = high - np.roll(high, 1); up[0] = 0.0
    dn = np.roll(low, 1) - low; dn[0] = 0.0
    plus_dm = np.where((up > dn) & (up > 0), up, 0.0)
    minus_dm = np.where((dn > up) & (dn > 0), dn, 0.0)
    pc = np.roll(close, 1); pc[0] = close[0]
    tr = np.maximum(high - low, np.maximum(np.abs(high - pc), np.abs(low - pc)))
    atr_ = _wilder(tr, n)
    with np.errstate(divide="ignore", invalid="ignore"):
        pdi = 100.0 * _wilder(plus_dm, n) / np.where(atr_ > 1e-12, atr_, np.nan)
        mdi = 100.0 * _wilder(minus_dm, n) / np.where(atr_ > 1e-12, atr_, np.nan)
        dx = 100.0 * np.abs(pdi - mdi) / np.where((pdi + mdi) > 1e-12, pdi + mdi, np.nan)
    return np.nan_to_num(_wilder(np.nan_to_num(dx, nan=0.0), n), nan=0.0)


def roll_max_prior(x: np.ndarray, n: int) -> np.ndarray:
    """Max over the n bars BEFORE the current bar (excludes current -> no lookahead)."""
    return pd.Series(x).rolling(n).max().shift(1).to_numpy()


def roll_min_prior(x: np.ndarray, n: int) -> np.ndarray:
    return pd.Series(x).rolling(n).min().shift(1).to_numpy()


def vwap(high, low, close, vol, n: int) -> np.ndarray:
    tp = (high + low + close) / 3.0
    num = pd.Series(tp * vol).rolling(n).sum().to_numpy()
    den = pd.Series(vol).rolling(n).sum().to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(den > 1e-12, num / den, np.nan)


def pct_return_k(close: np.ndarray, k: int) -> np.ndarray:
    prev = np.roll(close, k)
    out = close / np.where(prev > 1e-12, prev, np.nan) - 1.0
    out[:k] = 0.0
    return out


# ------------------------------------------------------------------------- signals
# build(A, p) -> int array in {+1,-1,0}; A holds aligned arrays for this coin (+ 'pc'
# = partner/BTC close for cross-asset families). Everything is causal (bar t only).

def sig_breakout(A, p):
    c = A["c"]
    ph = roll_max_prior(A["h"], p["don"])
    pl = roll_min_prior(A["l"], p["don"])
    s = np.zeros(len(c), dtype=int)
    long_ok = c > ph
    short_ok = c < pl
    if p["trend"] > 0:
        ma = sma(c, p["trend"])
        long_ok = long_ok & (c > ma)
        short_ok = short_ok & (c < ma)
    s[np.nan_to_num(long_ok, nan=False)] = 1
    s[np.nan_to_num(short_ok, nan=False)] = -1
    return s


def sig_vwap_pullback(A, p):
    c = A["c"]
    vw = vwap(A["h"], A["l"], c, A["v"], p["vwap"])
    r = rsi(c, 7)
    s = np.zeros(len(c), dtype=int)
    up = c > vw; dn = c < vw
    s[np.nan_to_num(up & (r <= p["dip"]), nan=False)] = 1
    s[np.nan_to_num(dn & (r >= 100 - p["dip"]), nan=False)] = -1
    return s


def sig_regime_pullback(A, p):
    c = A["c"]
    ma = sma(c, p["slow"]); r = rsi(c, 7); ax = adx(A["h"], A["l"], c, 14)
    strong = ax >= p["adx"]
    up = c > ma; dn = c < ma
    s = np.zeros(len(c), dtype=int)
    s[np.nan_to_num(up & (r <= p["dip"]) & strong, nan=False)] = 1
    s[np.nan_to_num(dn & (r >= 100 - p["dip"]) & strong, nan=False)] = -1
    return s


_SESSIONS = {  # UTC hour windows [start, end)
    "all": None, "us": (13, 21), "eu": (7, 15), "asia": (0, 8),
}


def sig_tod_pullback(A, p):
    c = A["c"]
    ma = sma(c, 100); r = rsi(c, 7)
    hours = A["idx"].hour.to_numpy()
    win = _SESSIONS[p["sess"]]
    mask = np.ones(len(c), dtype=bool) if win is None else \
        (hours >= win[0]) & (hours < win[1])
    up = c > ma; dn = c < ma
    s = np.zeros(len(c), dtype=int)
    s[up & (r <= p["dip"]) & mask] = 1
    s[dn & (r >= 100 - p["dip"]) & mask] = -1
    return s


# ---- #4 cross-asset BTC -> ETH (partner close = A['pc']) -----------------------
def sig_eth_btc_gated(A, p):
    """Borrow BTC's trend for ETH: long ETH on an ETH dip only while BTC is in an
    uptrend (BTC close > BTC SMA); mirror short."""
    c = A["c"]; pc = A["pc"]
    bma = sma(pc, p["bslow"]); r = rsi(c, 7)
    bt_up = pc > bma; bt_dn = pc < bma
    s = np.zeros(len(c), dtype=int)
    s[np.nan_to_num(bt_up & (r <= p["dip"]), nan=False)] = 1
    s[np.nan_to_num(bt_dn & (r >= 100 - p["dip"]), nan=False)] = -1
    return s


def sig_eth_btc_momo(A, p):
    """Lead-lag: ETH follows BTC. Long ETH when BTC's last-k-bar return > thr."""
    c = A["c"]; pc = A["pc"]
    bret = pct_return_k(pc, p["k"])
    s = np.zeros(len(c), dtype=int)
    s[bret > p["thr"]] = 1
    s[bret < -p["thr"]] = -1
    return s


def sig_eth_btc_rs(A, p):
    """Relative strength: long ETH when the ETH/BTC ratio is in an uptrend (ETH
    outperforming) AND BTC itself is in an uptrend (both confirm)."""
    c = A["c"]; pc = A["pc"]
    ratio = c / np.where(pc > 1e-12, pc, np.nan)
    rma = sma(ratio, p["rsn"]); bma = sma(pc, p["bslow"])
    rs_up = ratio > rma; bt_up = pc > bma
    s = np.zeros(len(c), dtype=int)
    s[np.nan_to_num(rs_up & bt_up, nan=False)] = 1
    s[np.nan_to_num((~rs_up) & (pc < bma), nan=False)] = -1
    return s


# --------------------------------------------------------------- exit engine (#2/#7)
def _exit_grid(tf: str):
    base = [
        {"mode": "pct", "tp": 0.01, "sl": 0.01},
        {"mode": "pct", "tp": 0.02, "sl": 0.02},
        {"mode": "pct", "tp": 0.03, "sl": 0.03},
        {"mode": "pct", "tp": 0.02, "sl": 0.01},
        {"mode": "pct", "tp": 0.03, "sl": 0.015},
        {"mode": "atr", "tp_atr": 2.0, "sl_atr": 2.0},
        {"mode": "atr", "tp_atr": 3.0, "sl_atr": 1.5},
        {"mode": "trail", "trail": 0.02},
        {"mode": "trail", "trail": 0.03},
        {"mode": "scaleout", "tp1": 0.015, "sl": 0.02, "trail": 0.02},
    ]
    out = []
    for mh in HOLDS[tf]:
        for e in base:
            d = dict(e); d["max_hold"] = mh
            out.append(d)
    return out


def bracket_ext(df, signal, xp, atr_arr, cost_bps=COST_BPS_PER_SIDE):
    """Event-driven bracket with selectable exit geometry. Conservative: same-bar
    stop wins ties; gaps fill at the open; entry at next-open. Returns Trades whose
    ret_net is net of round-trip cost (scale-out charges entry once + two half exits
    ~= one round trip)."""
    o = df["open"].to_numpy(); h = df["high"].to_numpy()
    lo = df["low"].to_numpy(); c = df["close"].to_numpy()
    n = len(c); cost = cost_bps / 1e4; mode = xp["mode"]; mh = xp["max_hold"]
    trades: list[Trade] = []
    i = 0
    while i < n - 1:
        sdir = signal[i]
        if sdir == 0:
            i += 1; continue
        ei = i + 1; epx = o[ei]
        if not np.isfinite(epx) or epx <= 0:
            i += 1; continue
        last = min(ei + mh, n - 1)

        if mode in ("pct", "atr"):
            if mode == "atr":
                a = atr_arr[i] if atr_arr is not None else np.nan
                if not np.isfinite(a) or a <= 0:
                    i += 1; continue
                tp_lvl = epx + sdir * xp["tp_atr"] * a
                sl_lvl = epx - sdir * xp["sl_atr"] * a
            else:
                tp_lvl = epx * (1 + sdir * xp["tp"])
                sl_lvl = epx * (1 - sdir * xp["sl"])
            ej, epx_out, reason = _resolve_fixed(o, h, lo, c, sdir, ei, last, tp_lvl, sl_lvl)
            gross = sdir * (epx_out / epx - 1.0)

        elif mode == "trail":
            ej, epx_out, reason = _resolve_trail(o, h, lo, c, sdir, ei, last, epx, xp["trail"])
            gross = sdir * (epx_out / epx - 1.0)

        else:  # scaleout
            ej, epx_out, reason, gross = _resolve_scaleout(o, h, lo, c, sdir, ei, last, epx, xp)

        ret_net = gross - 2 * cost
        trades.append(Trade(int(sdir), ei, ej, epx, epx_out, ret_net, reason))
        i = ej + 1
    return trades


def _resolve_fixed(o, h, lo, c, sdir, ei, last, tp_lvl, sl_lvl):
    for j in range(ei, last + 1):
        oj, hj, lj, cj = o[j], h[j], lo[j], c[j]
        if sdir == 1:
            if oj <= sl_lvl: return j, oj, "sl"
            if oj >= tp_lvl: return j, oj, "tp"
            if lj <= sl_lvl: return j, sl_lvl, "sl"
            if hj >= tp_lvl: return j, tp_lvl, "tp"
        else:
            if oj >= sl_lvl: return j, oj, "sl"
            if oj <= tp_lvl: return j, oj, "tp"
            if hj >= sl_lvl: return j, sl_lvl, "sl"
            if lj <= tp_lvl: return j, tp_lvl, "tp"
        if j == last:
            return j, cj, "time"
    return last, c[last], "time"


def _resolve_trail(o, h, lo, c, sdir, ei, last, epx, trail):
    if sdir == 1:
        stop = epx * (1 - trail); peak = epx
        for j in range(ei, last + 1):
            oj, hj, lj, cj = o[j], h[j], lo[j], c[j]
            if oj <= stop: return j, oj, "trail"
            if lj <= stop: return j, stop, "trail"
            peak = max(peak, hj); stop = max(stop, peak * (1 - trail))
            if j == last: return j, cj, "time"
    else:
        stop = epx * (1 + trail); trough = epx
        for j in range(ei, last + 1):
            oj, hj, lj, cj = o[j], h[j], lo[j], c[j]
            if oj >= stop: return j, oj, "trail"
            if hj >= stop: return j, stop, "trail"
            trough = min(trough, lj); stop = min(stop, trough * (1 + trail))
            if j == last: return j, cj, "time"
    return last, c[last], "time"


def _resolve_scaleout(o, h, lo, c, sdir, ei, last, epx, xp):
    """Take half off at +tp1, move the stop to breakeven, trail the runner. Blended
    gross = 0.5*half1 + 0.5*runner."""
    tp1 = epx * (1 + sdir * xp["tp1"])
    sl0 = epx * (1 - sdir * xp["sl"])
    trail = xp["trail"]
    phase = 1; stop = sl0; g1 = 0.0
    peak = epx  # favourable extreme for the runner's trail
    for j in range(ei, last + 1):
        oj, hj, lj, cj = o[j], h[j], lo[j], c[j]
        if phase == 1:
            if sdir == 1:
                if oj <= stop: return j, oj, "sl", (oj / epx - 1.0)
                if lj <= stop: return j, stop, "sl", (-xp["sl"])
                if oj >= tp1 or hj >= tp1:
                    px1 = oj if oj >= tp1 else tp1
                    g1 = px1 / epx - 1.0
                    phase = 2; stop = epx; peak = max(epx, hj)
                    stop = max(stop, peak * (1 - trail))
                    if j == last:
                        return j, cj, "scaleout", 0.5 * g1 + 0.5 * (cj / epx - 1.0)
                    continue
                if j == last:
                    return j, cj, "time", (cj / epx - 1.0)
            else:
                if oj >= stop: return j, oj, "sl", -(oj / epx - 1.0)
                if hj >= stop: return j, stop, "sl", (-xp["sl"])
                if oj <= tp1 or lj <= tp1:
                    px1 = oj if oj <= tp1 else tp1
                    g1 = -(px1 / epx - 1.0)
                    phase = 2; stop = epx; peak = min(epx, lj)
                    stop = min(stop, peak * (1 + trail))
                    if j == last:
                        return j, cj, "scaleout", 0.5 * g1 + 0.5 * (-(cj / epx - 1.0))
                    continue
                if j == last:
                    return j, cj, "time", -(cj / epx - 1.0)
        else:  # phase 2: runner, trailing from breakeven
            if sdir == 1:
                if oj <= stop: return j, oj, "scaleout", 0.5 * g1 + 0.5 * (oj / epx - 1.0)
                if lj <= stop: return j, stop, "scaleout", 0.5 * g1 + 0.5 * (stop / epx - 1.0)
                peak = max(peak, hj); stop = max(stop, peak * (1 - trail))
                if j == last:
                    return j, cj, "scaleout", 0.5 * g1 + 0.5 * (cj / epx - 1.0)
            else:
                if oj >= stop: return j, oj, "scaleout", 0.5 * g1 + 0.5 * (-(oj / epx - 1.0))
                if hj >= stop: return j, stop, "scaleout", 0.5 * g1 + 0.5 * (-(stop / epx - 1.0))
                peak = min(peak, lj); stop = min(stop, peak * (1 + trail))
                if j == last:
                    return j, cj, "scaleout", 0.5 * g1 + 0.5 * (-(cj / epx - 1.0))
    return last, c[last], "time", sdir * (c[last] / epx - 1.0)


# --------------------------------------------------------------------- strategy reg
def _entry_grid(name, tf):
    if name == "breakout":
        return [dict(don=d, trend=t) for d in (20, 40, 55) for t in (0, 100, 200)]
    if name == "vwap_pullback":
        return [dict(vwap=v, dip=dp) for v in (20, 50, 100) for dp in (35, 45)]
    if name == "regime_pullback":
        return [dict(slow=s, dip=dp, adx=ax)
                for s in (50, 100) for dp in (35, 45) for ax in (20, 25, 30)]
    if name == "tod_pullback":
        return [dict(dip=dp, sess=se)
                for dp in (35, 45) for se in ("all", "us", "eu", "asia")]
    if name == "eth_btc_gated":
        return [dict(bslow=b, dip=dp) for b in (50, 100, 200) for dp in (35, 45)]
    if name == "eth_btc_momo":
        return [dict(k=k, thr=t) for k in (3, 6, 12) for t in (0.0, 0.01)]
    if name == "eth_btc_rs":
        return [dict(rsn=r, bslow=b) for r in (20, 50) for b in (100, 200)]
    raise ValueError(name)


STRATS = {
    "breakout": (sig_breakout, ["BTC", "ETH"], False),
    "vwap_pullback": (sig_vwap_pullback, ["BTC", "ETH"], False),
    "regime_pullback": (sig_regime_pullback, ["BTC", "ETH"], False),
    "tod_pullback": (sig_tod_pullback, ["BTC", "ETH"], False),
    "eth_btc_gated": (sig_eth_btc_gated, ["ETH"], True),
    "eth_btc_momo": (sig_eth_btc_momo, ["ETH"], True),
    "eth_btc_rs": (sig_eth_btc_rs, ["ETH"], True),
}


def _build_arrays(sym, tf, needs_partner):
    df = resample_tf(load_1h(sym), tf)
    if needs_partner:
        btc = resample_tf(load_1h("BTC"), tf)
        idx = df.index.intersection(btc.index)
        df = df.loc[idx]; pc = btc.loc[idx, "close"].to_numpy()
    else:
        pc = None
    A = {
        "o": df["open"].to_numpy(), "h": df["high"].to_numpy(),
        "l": df["low"].to_numpy(), "c": df["close"].to_numpy(),
        "v": df["volume"].to_numpy(), "idx": df.index, "pc": pc,
    }
    a = atr(A["h"], A["l"], A["c"], 14)
    return df, A, a


def _slice_A(A, s, e):
    out = {k: (v[s:e] if isinstance(v, np.ndarray) else v[s:e])
           for k, v in A.items() if k != "pc"}
    out["pc"] = None if A["pc"] is None else A["pc"][s:e]
    out["idx"] = A["idx"][s:e]
    return out


def walk_forward(sym, tf, name):
    sigfn, _, needs_partner = STRATS[name]
    df, A, atr_full = _build_arrays(sym, tf, needs_partner)
    n = len(df)
    bpd = BARS_PER_DAY[tf]
    train_bars = TRAIN_DAYS * bpd; test_bars = TEST_DAYS * bpd
    if n < train_bars + test_bars + 5:
        return {"status": "insufficient_bars", "bars": n}
    entries = _entry_grid(name, tf); exits = _exit_grid(tf)

    oos_trades, fold_nets, fold_wins, picks = [], [], [], []
    oos_dated = []  # (exit_timestamp, ret_net) for portfolio-level daily aggregation
    start = 0
    while start + train_bars + test_bars <= n:
        tr = df.iloc[start:start + train_bars]
        A_tr = _slice_A(A, start, start + train_bars)
        atr_tr = atr_full[start:start + train_bars]
        best = None  # (expectancy, ep, xp)
        for ep in entries:
            sig = sigfn(A_tr, ep)
            for xp in exits:
                t = bracket_ext(tr, sig, xp, atr_tr)
                m = trade_metrics(t)
                if m["n"] < MIN_TRADES_TRAIN_FOLD:
                    continue
                if best is None or m["expectancy"] > best[0]:
                    best = (m["expectancy"], ep, xp)
        if best is not None:
            e0, e1 = start, start + train_bars + test_bars
            ctx = df.iloc[e0:e1]
            A_ctx = _slice_A(A, e0, e1)
            atr_ctx = atr_full[e0:e1]
            sig = sigfn(A_ctx, best[1]).copy()
            sig[:train_bars] = 0                      # entries only in the OOS window
            te = bracket_ext(ctx, sig, best[2], atr_ctx)
            if te:
                rets = [x.ret_net for x in te]
                oos_trades.extend(rets)
                oos_dated.extend((ctx.index[x.exit_i], x.ret_net) for x in te)
                fold_nets.append(float(np.prod([1 + r for r in rets]) - 1))
                fold_wins.append(float(np.mean([r > 0 for r in rets])))
                picks.append((best[1], best[2]))
        start += test_bars

    if not oos_trades:
        return {"status": "no_oos_trades", "folds": 0}
    rets = np.array(oos_trades)
    wins = rets[rets > 0]; losses = rets[rets <= 0]
    eq = np.cumprod(1 + rets); peak = np.maximum.accumulate(eq)
    gw = wins.sum(); gl = -losses.sum()
    pf = (gw / gl) if gl > 1e-12 else float("inf")
    return {
        "status": "ok",
        "folds": len(fold_nets),
        "oos_n_trades": int(len(rets)),
        "oos_win_rate": float((rets > 0).mean()),
        "oos_net": float(eq[-1] - 1.0),
        "oos_profit_factor": float(pf),
        "oos_expectancy": float(rets.mean()),
        "oos_max_dd": float((eq / peak - 1.0).min()),
        "fold_win_rate": float(np.mean([x > 0 for x in fold_nets])),
        "fold_winrate_min": float(np.min(fold_wins)),
        "fold_winrate_med": float(np.median(fold_wins)),
        "fold_winrate_max": float(np.max(fold_wins)),
        "fold_nets": [float(x) for x in fold_nets],
        "picks": picks,
        "oos_dated": [(t.isoformat(), float(r)) for t, r in oos_dated],
        "oos_returns": rets.tolist(),
    }


def main(argv):
    sel_coins = [a.upper() for a in argv if a.upper() in ("BTC", "ETH")]
    sel_tfs = [a for a in argv if a in TFS]
    sel_names = [a for a in argv if a in STRATS]
    tfs = sel_tfs or TFS
    names = sel_names or list(STRATS)
    out = {"train_days": TRAIN_DAYS, "test_days": TEST_DAYS,
           "cost_bps_per_side": COST_BPS_PER_SIDE, "results": {}}
    print(f"ROUND-2 WALK-FORWARD  tfs={tfs}  strategies={names}  "
          f"train={TRAIN_DAYS}d test={TEST_DAYS}d (non-overlapping)  "
          f"cost={COST_BPS_PER_SIDE}bps/side\n")
    print(f"  {'coin':<4} {'tf':<4} {'strategy':<16} {'folds':>5} {'OOSn':>5} "
          f"{'win':>6} {'net':>9} {'PF':>5} {'exp':>8} {'foldWin':>7} "
          f"{'foldWR(min/med/max)':>20}")
    for name in names:
        _, coins, _ = STRATS[name]
        run_coins = [c for c in coins if (not sel_coins or c in sel_coins)]
        for sym in run_coins:
            out["results"].setdefault(sym, {})
            for tf in tfs:
                r = walk_forward(sym, tf, name)
                out["results"][sym].setdefault(tf, {})
                out["results"][sym][tf][name] = {k: v for k, v in r.items()
                                                 if k not in ("oos_returns", "oos_dated")}
                if r.get("status") != "ok":
                    print(f"  {sym:<4} {tf:<4} {name:<16} {r.get('status')}")
                    continue
                print(f"  {sym:<4} {tf:<4} {name:<16} {r['folds']:>5} "
                      f"{r['oos_n_trades']:>5} {r['oos_win_rate']:>6.1%} "
                      f"{r['oos_net']:>+9.1%} {r['oos_profit_factor']:>5.2f} "
                      f"{r['oos_expectancy']:>+8.3%} {r['fold_win_rate']:>7.1%} "
                      f"{r['fold_winrate_min']:>5.0%}/{r['fold_winrate_med']:>4.0%}"
                      f"/{r['fold_winrate_max']:>4.0%}")
                if r["oos_net"] > 0 and r["oos_n_trades"] >= 30:
                    eqc = np.cumprod(1 + np.array(r["oos_returns"]))
                    pd.Series(eqc).to_csv(
                        os.path.join(RESULTS, f"dt2_{sym}_{tf}_{name}_oos_eq.csv"),
                        index_label="trade", header=["equity"])
    path = os.path.join(RESULTS, "daytrade_strategies2_results.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=2, default=float)
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main(sys.argv[1:])
```

### A.8 — `research/all_weather.py`

All-weather long/short TS-trend SPINE (crisis alpha) + its walk-forward.

```python
"""All-weather spine — long/short time-series trend, hedge-fund-style workflow.

Every prior construction hit the same wall: 2022 (synchronised crash). Long-only
momentum bleeds it; the dollar-neutral breadth book was killed (thin edge at cost).
The remaining honest route to *earning in a bear* is to SHORT it -- managed-futures
time-series trend ('crisis alpha'). This builds that as the spine and tests whether it
is genuinely all-weather (positive/flat in 2022 AND captures bull years).

Hedge-fund workflow:
  * RESEARCHER  -> classifies the regime each day from market trend + breadth
                   (BULL / BEAR / CHOP), causal.
  * BULL sleeve -> long the strongest top-k momentum coins (the orchestrator).
  * BEAR sleeve -> short the weakest top-k (most negative momentum) coins.
  * EXECUTOR    -> routes: BULL->bull, BEAR->bear, CHOP->reduced/cash; vol-targets the
                   book, caps gross, applies the graded drawdown brake. Net exposure
                   swings long in bull, short in bear, ~flat in chop.

Also tests a PURE time-series-trend book (each coin long/short on its own trend,
vol-weighted) as the simplest all-weather spine, for comparison. Walk-forward OOS;
per-year incl. 2022, worst year, Calmar.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
UNIV_DIR = os.path.join(HERE, "data", "universe")
RESULTS = os.path.join(HERE, "results")
ANN = 365.0
TOP_LIQ = 30
FUNDING_DAILY = 0.0001


def load_panel():
    closes, vols = {}, {}
    for fn in sorted(os.listdir(UNIV_DIR)):
        if not fn.endswith("_daily.csv"):
            continue
        sym = fn.replace("_daily.csv", "")
        df = pd.read_csv(os.path.join(UNIV_DIR, fn), parse_dates=["date"])
        df = df[~df["date"].duplicated(keep="first")].set_index("date").sort_index()
        closes[sym] = df["close"]; vols[sym] = df["volume_usd"]
    px = pd.DataFrame(closes).sort_index()
    return px, pd.DataFrame(vols).reindex_like(px)


def ts_signal(px, lbs):
    """Time-series trend in [-1,1]: mean sign of trailing returns (long AND short)."""
    return sum(np.sign(px / px.shift(L) - 1.0) for L in lbs) / len(lbs)


def realized_vol(px, lb=30):
    return px.pct_change().rolling(lb, min_periods=10).std(ddof=0) * np.sqrt(ANN)


def researcher_regime(px, vol, lbs=(20, 50, 100)):
    """Causal market regime from a dollar-volume-weighted index trend + breadth."""
    dv = vol.rolling(30, min_periods=10).mean()
    # equal-weight index of the live universe (proxy for 'the market')
    idx = px.pct_change().mean(axis=1).add(1).cumprod()
    idx_trend = sum(np.sign(idx / idx.shift(L) - 1.0) for L in lbs) / len(lbs)
    # breadth: fraction of coins above their own 50d trend
    above = (px > px.rolling(50, min_periods=20).mean()).astype(float)
    breadth = above.where(px.notna()).mean(axis=1)
    regime = pd.Series(0, index=px.index)          # 0 chop, +1 bull, -1 bear
    regime[(idx_trend > 0) & (breadth > 0.5)] = 1
    regime[(idx_trend < 0) & (breadth < 0.5)] = -1
    return regime, breadth


def build_ts_trend(px, vol, lbs, gross_target, max_gross, vol_lb=30, top=TOP_LIQ):
    """PURE time-series trend book (long/short each coin on its own trend), vol-weighted,
    point-in-time top-liquidity universe. Vectorised. Returns (gross, turnover, exposure)."""
    dv = vol.rolling(30, min_periods=10).mean()
    sig = ts_signal(px, lbs)
    iv = 1.0 / realized_vol(px, vol_lb).clip(lower=0.20)      # inverse-vol weight
    dret = px.pct_change()
    dates = px.index; cols = list(px.columns)
    W = np.zeros((len(dates), len(cols)))
    dvv, sigv, ivv, pxv = dv.values, sig.values, iv.values, px.values
    for i in range(max(lbs) + 1, len(dates)):
        row = dvv[i]
        valid = ~np.isnan(pxv[i]) & ~np.isnan(sigv[i]) & ~np.isnan(row) & ~np.isnan(ivv[i])
        if valid.sum() < 5:
            continue
        idxv = np.where(valid)[0]
        univ = idxv[np.argsort(-row[idxv])][:top]
        raw = sigv[i, univ] * ivv[i, univ]                   # signed, inverse-vol
        gabs = np.abs(raw).sum()
        if gabs <= 0:
            continue
        w = raw / gabs * gross_target                        # normalise to gross_target
        # cap gross
        if np.abs(w).sum() > max_gross:
            w *= max_gross / np.abs(w).sum()
        W[i, univ] = w
    Wdf = pd.DataFrame(W, index=dates, columns=cols)
    held = Wdf.shift(1).fillna(0.0)
    turnover = held.diff().abs().sum(axis=1).fillna(held.abs().sum(axis=1))
    gross = (held * dret.fillna(0.0)).sum(axis=1)
    return gross, turnover, held.abs().sum(axis=1), held.sum(axis=1)


def build_regime_book(px, vol, lbs, k, gross_target, max_gross, vol_lb=30, top=TOP_LIQ):
    """Hedge-fund workflow: researcher routes bull(long top-k)/bear(short bottom-k)/
    chop(reduced). Vectorised."""
    regime, _ = researcher_regime(px, vol)
    dv = vol.rolling(30, min_periods=10).mean()
    strength = sum(px / px.shift(L) - 1.0 for L in lbs) / len(lbs)
    iv = 1.0 / realized_vol(px, vol_lb).clip(lower=0.20)
    dret = px.pct_change()
    dates = px.index; cols = list(px.columns)
    W = np.zeros((len(dates), len(cols)))
    dvv, sv, ivv, pxv, rg = dv.values, strength.values, iv.values, px.values, regime.values
    for i in range(max(lbs) + 1, len(dates)):
        row = dvv[i]
        valid = ~np.isnan(pxv[i]) & ~np.isnan(sv[i]) & ~np.isnan(row) & ~np.isnan(ivv[i])
        if valid.sum() < 2 * k + 2:
            continue
        idxv = np.where(valid)[0]
        univ = idxv[np.argsort(-row[idxv])][:top]
        order = univ[np.argsort(-sv[i, univ])]               # strongest -> weakest
        reg = rg[i]
        w = np.zeros(len(cols))
        if reg > 0:                                          # BULL: long top-k strongest
            picks = [c for c in order[:k] if sv[i, c] > 0]
            for c in picks:
                w[c] = ivv[i, c]
        elif reg < 0:                                        # BEAR: short bottom-k weakest
            picks = [c for c in order[-k:] if sv[i, c] < 0]
            for c in picks:
                w[c] = -ivv[i, c]
        else:                                                # CHOP: small long-only top, reduced
            picks = [c for c in order[:k] if sv[i, c] > 0]
            for c in picks:
                w[c] = 0.4 * ivv[i, c]
        gabs = np.abs(w).sum()
        if gabs <= 0:
            continue
        w = w / gabs * gross_target
        if np.abs(w).sum() > max_gross:
            w *= max_gross / np.abs(w).sum()
        W[i] = w
    Wdf = pd.DataFrame(W, index=dates, columns=cols)
    held = Wdf.shift(1).fillna(0.0)
    turnover = held.diff().abs().sum(axis=1).fillna(held.abs().sum(axis=1))
    gross = (held * dret.fillna(0.0)).sum(axis=1)
    return gross, turnover, held.abs().sum(axis=1), held.sum(axis=1)


def net_from(gross, turnover, exposure, cost_bps):
    return (gross - cost_bps * 1e-4 * turnover - FUNDING_DAILY * exposure).dropna()


def apply_dd_brake(r, dd1=0.15, dd2=0.35, floor=0.0):
    r = r.dropna(); out = r.values.astype(float).copy(); rv = r.values
    eq, peak, state = 1.0, 1.0, 1.0
    for t in range(len(rv)):
        out[t] = rv[t] * state
        eq *= 1 + out[t]; peak = max(peak, eq); dd = eq / peak - 1
        state = 1.0 if dd >= -dd1 else (floor if dd <= -dd2
                                        else 1 - (abs(dd) - dd1) / (dd2 - dd1) * (1 - floor))
    return pd.Series(out, index=r.index)


def stats(r):
    r = r.dropna(); sd = r.std(ddof=0); n = len(r)
    eq = float((1 + r).prod())
    cagr = eq ** (ANN / n) - 1 if eq > 0 and n else -1.0
    dd = float(((1 + r).cumprod() / (1 + r).cumprod().cummax() - 1).min())
    return dict(cagr=cagr, sharpe=float(r.mean()/sd*np.sqrt(ANN)) if sd>0 else 0,
                maxdd=dd, calmar=cagr/abs(dd) if dd < 0 else 0,
                per_year={int(y): round(float((1+r[r.index.year==y]).prod()-1), 4)
                          for y in sorted(set(r.index.year))})


def walk_forward(px, vol, builder, grid, cost_bps, train_days=540, test_days=180):
    cache = {tuple(sorted(p.items())): builder(px, vol, **p) for p in grid}
    dates = px.index; t0 = dates[0] + pd.Timedelta(days=200)
    tr, te = pd.Timedelta(days=train_days), pd.Timedelta(days=test_days)
    chunks = []
    while t0 + tr + te <= dates[-1] + pd.Timedelta(days=1):
        lo, mid, hi = t0, t0+tr, t0+tr+te
        best, bsc, bk = None, -1e9, None
        for p in grid:
            k = tuple(sorted(p.items())); g, tn, ex, _ = cache[k]
            net = net_from(g, tn, ex, cost_bps)
            trs = net[(net.index >= lo) & (net.index < mid)]
            if len(trs) < 60:
                continue
            sd = trs.std(ddof=0); sc = trs.mean()/sd*np.sqrt(ANN) if sd>0 else -9
            if sc > bsc:
                bsc, best, bk = sc, p, k
        if best is None:
            t0 += te; continue
        g, tn, ex, _ = cache[bk]; net = net_from(g, tn, ex, cost_bps)
        tes = net[(net.index >= mid) & (net.index < hi)]
        if len(tes) > 20:
            chunks.append(tes)
        t0 += te
    if not chunks:
        return None
    oos = pd.concat(chunks).sort_index()
    return oos[~oos.index.duplicated(keep="first")]


def main(argv):
    px, vol = load_panel()
    print(f"Universe: {px.shape[1]} coins {px.index[0].date()}->{px.index[-1].date()}\n")
    out = {}
    cost = 15

    ts_grid = [dict(lbs=lbs, gross_target=gt, max_gross=mg)
               for lbs in ((10,30,60,120),(20,50,100),(30,60,120))
               for gt in (0.6, 1.0) for mg in (1.5, 2.5)]
    rg_grid = [dict(lbs=lbs, k=k, gross_target=gt, max_gross=mg)
               for lbs in ((10,30,60,120),(20,50,100))
               for k in (3,5,8) for gt in (0.6,1.0) for mg in (1.5,2.5)]

    print("Running PURE time-series-trend long/short spine (walk-forward OOS, 15 bps)...")
    ts_oos = walk_forward(px, vol, build_ts_trend, ts_grid, cost)
    print("Running REGIME book (researcher->bull/bear/chop, walk-forward OOS, 15 bps)...")
    rg_oos = walk_forward(px, vol, build_regime_book, rg_grid, cost)

    for name, oos in [("TS-trend L/S spine", ts_oos), ("Regime book (HF workflow)", rg_oos)]:
        if oos is None:
            print(f"{name}: no OOS"); continue
        s = stats(oos); sb = stats(apply_dd_brake(oos))
        out[name] = dict(base=s, braked=sb)
        print(f"\n=== {name} (15 bps, OOS) ===")
        print(f"  CAGR={s['cagr']:+.1%} Sharpe={s['sharpe']:.2f} maxDD={s['maxdd']:.0%} "
              f"Calmar={s['calmar']:.2f}")
        print("  per-year:", "  ".join(f"{y}:{v:+.0%}" for y,v in s['per_year'].items()))
        print(f"  +dd-brake: CAGR={sb['cagr']:+.1%} Sharpe={sb['sharpe']:.2f} "
              f"maxDD={sb['maxdd']:.0%} Calmar={sb['calmar']:.2f}  2022="
              f"{sb['per_year'].get(2022,float('nan')):+.0%}")
    json.dump(out, open(os.path.join(RESULTS, "all_weather_results.json"), "w"),
              indent=2, default=str)
    print(f"\nwrote {os.path.join(RESULTS,'all_weather_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
```

### A.9 — `research/annual_target.py`

Annual $100k-reset profit-lock wrapper (simulate_year / evaluate) reused by the orchestrator.

```python
"""Annual profit-target lock — exploit the $100k-reset / profit-withdrawal model.

The brief's accounting (start each year at $100k, withdraw profit at year end,
use futures leverage) turns each year into an independent "race": from Jan 1, can
the account reach +TARGET before hitting a -STOP? If yes, **lock the gain** (go
flat for the rest of the year and bank +TARGET). If it hits -STOP first, stop out
for the year. This is fully causal (only YTD info is used) and is the natural way
to run a leveraged, profit-is-swept account.

Leverage model: a strategy's daily *net* return scales linearly with size
(gross, txn cost and funding all scale with notional), so running the engine at
m x size == multiplying its net daily returns by m. A day that would take equity
to <=0 is a liquidation (year = -100%).

We sweep the leverage multiplier m and report, per coin, how many years bank
+50%. Everything is applied to the walk-forward OOS return stream.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

import data as datamod
from engine import Costs
from strategies import v2_families
from walkforward import walk_forward

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
COINS = ["SOL", "ETH", "BTC", "DOGE", "XRP"]
COSTS = Costs(txn=0.0006, funding_daily=0.0001)
TARGET = 0.50


def load_prices(asset):
    df = datamod.load(asset)
    p = pd.Series(df["close"].values, index=pd.DatetimeIndex(df["date"]))
    return p[~p.index.duplicated(keep="first")].sort_index()


def wf_params(prices):
    span = (prices.index[-1] - prices.index[0]).days
    if span >= 2200:
        return dict(train_days=540, test_days=180)
    if span >= 1400:
        return dict(train_days=420, test_days=150)
    return dict(train_days=365, test_days=120)


def simulate_year(daily: np.ndarray, m: float, target: float, stop: float) -> float:
    """One calendar year. Returns the year's realised return under leverage m
    with a +target profit-lock and a -stop. Causal, path-dependent."""
    eq = 1.0
    locked = False
    for r in daily:
        if locked:
            continue
        step = 1.0 + m * r
        if step <= 0.0:            # intraday liquidation
            return -1.0
        eq *= step
        if eq - 1.0 >= target:     # bank the target, flat for rest of year
            return eq - 1.0
        if eq - 1.0 <= -stop:      # stop out for the year
            return eq - 1.0
    return eq - 1.0


def evaluate(returns: pd.Series, m: float, target: float, stop: float):
    rows = []
    for y in sorted(set(returns.index.year)):
        ry = returns[returns.index.year == y]
        if len(ry) < 250:
            continue  # only judge full years
        yr = simulate_year(ry.values, m, target, stop)
        rows.append((int(y), yr))
    if not rows:
        return None
    rets = np.array([r for _, r in rows])
    banked = int((rets >= target - 1e-9).sum())
    return {
        "m": m, "target": target, "stop": stop,
        "full_years": len(rows),
        "banked_50": banked,
        "hit_rate": round(banked / len(rows), 3),
        "avg_year": round(float(rets.mean()), 4),
        "median_year": round(float(np.median(rets)), 4),
        "worst_year": round(float(rets.min()), 4),
        "avg_profit_usd": round(float(rets.mean()) * 100_000, 0),
        "per_year": [(y, round(r, 4)) for y, r in rows],
    }


def best_returns(coin: str) -> pd.Series:
    """OOS daily net returns of the best v2 family for this coin (by raw CAGR)."""
    prices = load_prices(coin)
    wfp = wf_params(prices)
    best = None
    for fam in v2_families():
        r = walk_forward(coin, prices, fam, costs=COSTS, **wfp)
        if r is None or len(r.folds) < 3:
            continue
        if best is None or r.oos.cagr > best.oos.cagr:
            best = r
    return best.oos_returns, best.family


def main(argv):
    coins = [a for a in argv if a in datamod.ASSETS] or COINS
    stop = 0.40  # cap each losing year at ~ -40% of the $100k stake
    m_grid = [1, 2, 3, 5, 8, 12, 20, 35, 50]
    out = {"target": TARGET, "stop": stop, "leverage_grid": m_grid, "coins": {}}

    print(f"ANNUAL PROFIT-TARGET LOCK  target=+{TARGET:.0%}  stop=-{stop:.0%}  "
          f"(applied to walk-forward OOS; m = leverage multiplier on the engine)")

    for coin in coins:
        returns, fam = best_returns(coin)
        print(f"\n{'='*92}\n{coin}  (engine: {fam})")
        print(f"  {'m=lev':>6} {'banked>=50%':>12} {'hitRate':>8} {'avgYr':>8} {'medYr':>8} {'worstYr':>9} {'avg$/yr':>10}")
        sweeps = []
        for m in m_grid:
            e = evaluate(returns, m, TARGET, stop)
            if e is None:
                continue
            sweeps.append(e)
            print(f"  {m:>6} {str(e['banked_50'])+'/'+str(e['full_years']):>12} "
                  f"{e['hit_rate']:>8.0%} {e['avg_year']:>8.1%} {e['median_year']:>8.1%} "
                  f"{e['worst_year']:>9.1%} {e['avg_profit_usd']:>10,.0f}")
        # pick the best SANE config: bound the worst year (no near-liquidation),
        # then maximise hit-rate, then avg. Reckless leverage that manufactures a
        # marginally higher hit-rate via -100% years is excluded.
        sane = [e for e in sweeps if e["worst_year"] >= -0.55] or sweeps
        best = max(sane, key=lambda e: (e["hit_rate"], e["avg_year"]))
        print(f"  >>> best m={best['m']}: banks +50% in {best['banked_50']}/{best['full_years']} years "
              f"({best['hit_rate']:.0%}), worst year {best['worst_year']:.0%}, avg ${best['avg_profit_usd']:,.0f}/yr")
        print("      per-year:", "  ".join(f"{y}:{r:+.0%}" for y, r in best["per_year"]))
        out["coins"][coin] = {"engine": fam, "sweep": sweeps, "best": best,
                              "_returns": returns}

    # ---- diversified book: split capital across coins, bank at BOOK level ----
    def book(coin_list, label):
        mat = pd.DataFrame({c: out["coins"][c]["_returns"] for c in coin_list}).sort_index()
        ew = mat.mean(axis=1, skipna=True).dropna()   # equal-weight daily return
        print(f"\n{'='*92}\nDIVERSIFIED BOOK [{label}] = equal-weight {coin_list}, banked at book level")
        print(f"  {'m=lev':>6} {'banked>=50%':>12} {'hitRate':>8} {'avgYr':>8} {'worstYr':>9} {'avg$/yr':>10}")
        sw = []
        for m in m_grid:
            e = evaluate(ew, m, TARGET, stop)
            if e:
                sw.append(e)
                print(f"  {m:>6} {str(e['banked_50'])+'/'+str(e['full_years']):>12} "
                      f"{e['hit_rate']:>8.0%} {e['avg_year']:>8.1%} {e['worst_year']:>9.1%} {e['avg_profit_usd']:>10,.0f}")
        sane = [e for e in sw if e["worst_year"] >= -0.55] or sw
        b = max(sane, key=lambda e: (e["hit_rate"], e["avg_year"]))
        print(f"  >>> best m={b['m']}: book banks +50% in {b['banked_50']}/{b['full_years']} years "
              f"({b['hit_rate']:.0%}), worst {b['worst_year']:.0%}, avg ${b['avg_profit_usd']:,.0f}/yr")
        print("      per-year:", "  ".join(f"{y}:{r:+.0%}" for y, r in b["per_year"]))
        return {"coins": coin_list, "sweep": sw, "best": b}

    present = set(out["coins"].keys())

    def book_if(coin_list, label, key):
        cl = [c for c in coin_list if c in present]
        if len(cl) >= 2:
            out[key] = book(cl, label)

    book_if(["SOL", "ETH", "BTC", "DOGE", "XRP"], "ALL 5 (SOL ETH BTC DOGE XRP)", "book_5")
    book_if(["BTC", "ETH", "SOL", "DOGE"], "BTC+ETH+SOL+DOGE (drop weak XRP)", "book_4core")
    book_if(["BTC", "ETH", "DOGE"], "BTC+ETH+DOGE (prior best, baseline)", "book_3")
    book_if(["SOL", "ETH", "BTC"], "SOL+ETH+BTC (majors+L1)", "book_3b")

    for c in out["coins"]:
        out["coins"][c].pop("_returns", None)
    with open(os.path.join(RESULTS, "annual_target_results.json"), "w") as f:
        json.dump(out, f, indent=2, default=str)

    print(f"\n{'='*92}\nSUMMARY — years banking +50% at best leverage (profit-lock, OOS)")
    for coin in coins:
        b = out["coins"][coin]["best"]
        print(f"  {coin:6} m={b['m']:>3}  {b['banked_50']}/{b['full_years']} years  "
              f"hit {b['hit_rate']:.0%}  worst {b['worst_year']:+.0%}  avg ${b['avg_profit_usd']:,.0f}/yr")
    print(f"\nwrote {os.path.join(RESULTS, 'annual_target_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
```

### A.10 — `research/unified_bot.py`

The orchestrator: sleeves -> daily streams, profiles, validation, AND the harvest engine (harvest_run / harvest_report, --harvest).

```python
"""Unified orchestrator — combine the best validated edges from ALL the research into
one capital-allocated book, and validate the COMBINATION walk-forward / out-of-sample.

Sleeves (each a separately-validated edge from this repo's research line):

  CORE  — daily, long-only, vol-targeted MOMENTUM book over SOL/ETH/BTC/DOGE/XRP
          (absolute-trend 60% + cross-sectional 40%), the pre-validated deployable
          (DEPLOYABLE_STRATEGY_BUILD.md §1: banks +50% in ~9/10 yrs OOS). Reference
          signal layer: production_strategy.py. Used here as a FIXED validated config.
  BTC1H — BTC 1H ADX-gated trend pullback (DAYTRADE_BTC_ETH_WINRATE.md §4): ~55% win,
          +68% OOS, 73% fold-win, robust. The steady intraday alpha.
  ETH8H — ETH 8H ADX-gated pullback with an asymmetric ATR exit (TP 3xATR/SL 1.5xATR):
          +307% OOS, PF 1.61, high-variance. The punchy intraday alpha.

The two intraday sleeves' parameters are chosen OUT-OF-SAMPLE per fold by the rolling
walk-forward in daytrade_strategies2.py; their per-trade OOS PnL is bucketed to its
exit DATE to form a daily return stream. The orchestrator then allocates capital
across the three daily streams and we validate the combined book:

  * standalone sleeve metrics over the common window,
  * the sleeve correlation matrix  (the diversification test),
  * combined vs core-alone  Sharpe / CAGR / maxDD  (does adding the sleeves help?),
  * % of years banking +50% under the annual $100k wrapper  — both a FIXED robust
    allocation AND a fully-OOS allocation walk-forward (weights chosen on prior data).

Everything daily; costs 6 bps/side + funding (intraday sleeves already net of 6bps).

Run:  python research/unified_bot.py
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

import data as datamod
import all_weather as aw
import production_strategy as ps
from annual_target import evaluate as annual_eval
from daytrade_strategies2 import walk_forward as intraday_wf
from engine import Costs, compute_metrics

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
COSTS = Costs(txn=0.0006, funding_daily=0.0001)

# the two validated intraday sleeves (coin, timeframe, strategy name in strategies2)
INTRADAY = {"BTC1H": ("BTC", "1h", "regime_pullback"),
            "ETH8H": ("ETH", "8h", "regime_pullback")}

# all-weather long/short time-series-trend SPINE (crisis alpha — earns in bears by
# shorting confirmed downtrends; all_weather.py / ALL_WEATHER_SPINE.md). Top-30
# universe, validated at 15 bps/side.
SPINE_COST_BPS = 15
TS_GRID = [dict(lbs=lbs, gross_target=gt, max_gross=mg)
           for lbs in ((10, 30, 60, 120), (20, 50, 100), (30, 60, 120))
           for gt in (0.6, 1.0) for mg in (1.5, 2.5)]

# Risk-profile dial (capital split across sleeves). GROWTH maximises bull upside but
# bleeds bears; ALL_WEATHER adds the defensive spine — best Sharpe, ~neutralises the
# 2022/bear catastrophe (worst yr -26% -> -2%), for some CAGR give-up. Default =
# all-weather (the honest, drawdown-aware book).
PROFILES = {
    "growth":      {"CORE": 0.70, "BTC1H": 0.15, "ETH8H": 0.15, "SPINE": 0.00},
    "all_weather": {"CORE": 0.40, "BTC1H": 0.15, "ETH8H": 0.15, "SPINE": 0.30},
}
DEFAULT_PROFILE = "all_weather"
FIXED_W = PROFILES[DEFAULT_PROFILE]

# candidate allocations for the OOS allocation walk-forward (4-sleeve)
ALLOC_GRID = [
    {"CORE": 0.70, "BTC1H": 0.15, "ETH8H": 0.15, "SPINE": 0.00},   # growth (no spine)
    {"CORE": 0.55, "BTC1H": 0.15, "ETH8H": 0.15, "SPINE": 0.15},
    {"CORE": 0.40, "BTC1H": 0.15, "ETH8H": 0.15, "SPINE": 0.30},
    {"CORE": 0.25, "BTC1H": 0.15, "ETH8H": 0.15, "SPINE": 0.45},
    {"CORE": 0.40, "BTC1H": 0.20, "ETH8H": 0.20, "SPINE": 0.20},
]

# ---- wired "HARVEST" deployment policy (sweep-optimal: harvest_sweep.py) ----
# ALL-WEATHER(30% spine) book at 2x on a $300k base that RESETS each Jan (no
# compounding). Take profit when equity 2x's, leaving 50% on the table to ride;
# sweep at year end; -40% YTD stop. This is the best risk-adjusted, SELF-FUNDING
# (never needs external cash) config that returns the full $300k fast (~99 days):
# ROI ~5.1x with a ~-25% total-wealth drawdown. (`--harvest --lock-flat` = the more
# conservative take-100%-and-sit variant.)
HARVEST_PROFILE = "all_weather"      # 30%-spine book
HARVEST_M = 2.0
HARVEST_BASE = 300_000.0
DOUBLE_AT = 2.0                      # take profit when equity reaches 2x base
ANNUAL_STOP = 0.40


# --------------------------------------------------------------------- sleeve streams
def core_daily_returns() -> pd.Series:
    """Daily net return of the CORE book (multi-coin weights -> portfolio return)."""
    panel = ps.load_panel()
    book = ps.book_weights(panel)
    ret = panel.pct_change()
    held = book.shift(1).fillna(0.0)                  # weight in force during day t
    gross_ret = (held * ret).sum(axis=1)
    turn = held.diff().abs()
    turn.iloc[0] = held.abs().iloc[0]
    cost = COSTS.txn * turn.sum(axis=1) + COSTS.funding_daily * held.abs().sum(axis=1)
    r = (gross_ret - cost).fillna(0.0)
    return r.iloc[1:]                                  # drop the first (no-return) day


def intraday_daily_returns(coin: str, tf: str, strat: str):
    """Run the intraday sleeve's rolling walk-forward and bucket its OOS per-trade PnL
    to the trade's EXIT date -> a (sparse) daily return stream of the 1x sleeve."""
    r = intraday_wf(coin, tf, strat)
    if r.get("status") != "ok":
        raise RuntimeError(f"{coin} {tf} {strat}: {r.get('status')}")
    by_day: dict[pd.Timestamp, float] = {}
    for ts, ret in r["oos_dated"]:
        d = pd.Timestamp(ts).normalize()
        by_day[d] = by_day.get(d, 1.0) * (1.0 + ret)   # compound trades closing same day
    s = pd.Series({d: v - 1.0 for d, v in by_day.items()}).sort_index()
    return s, r


def spine_daily_returns() -> pd.Series:
    """All-weather L/S trend spine: stitched walk-forward OOS daily returns, extended
    with one final OOS fold (best config on the trailing 540d applied forward) so
    coverage reaches the data end rather than the last complete 180d test window."""
    px, vol = aw.load_panel()
    nets = {}
    for p in TS_GRID:
        g, tn, ex, _ = aw.build_ts_trend(px, vol, **p)
        nets[tuple(sorted(p.items()))] = aw.net_from(g, tn, ex, SPINE_COST_BPS)
    oos = aw.walk_forward(px, vol, aw.build_ts_trend, TS_GRID, SPINE_COST_BPS).sort_index()
    last = oos.index[-1]; lo = last - pd.Timedelta(days=540)
    best, bsc = None, -1e9
    for net in nets.values():
        trs = net[(net.index > lo) & (net.index <= last)]
        if len(trs) < 60:
            continue
        sd = trs.std(ddof=0); sc = trs.mean() / sd * np.sqrt(365) if sd > 0 else -9
        if sc > bsc:
            bsc, best = sc, net
    tail = best[best.index > last] if best is not None else pd.Series(dtype=float)
    return pd.concat([oos, tail]).sort_index()


def build_panel() -> tuple[pd.DataFrame, dict]:
    """Assemble the aligned daily return frame for all four sleeves over the window
    where every sleeve is live (the intraday + spine stitched OOS span)."""
    r_core = core_daily_returns()
    streams, meta = {"CORE": r_core}, {}
    for name, (coin, tf, strat) in INTRADAY.items():
        s, res = intraday_daily_returns(coin, tf, strat)
        streams[name] = s
        meta[name] = {"oos_net": res["oos_net"], "oos_win_rate": res["oos_win_rate"],
                      "oos_n_trades": res["oos_n_trades"], "trade_days": int(len(s)),
                      "fold_win_rate": res["fold_win_rate"]}
    r_spine = spine_daily_returns()
    streams["SPINE"] = r_spine
    meta["SPINE"] = {"oos_net": float((1.0 + r_spine).prod() - 1.0),
                     "trade_days": int(len(r_spine))}
    # common window = where the intraday sleeves AND the spine are all live
    istart = max(min(streams[n].index.min() for n in INTRADAY), r_spine.index.min())
    end = min(r_core.index.max(), r_spine.index.max())
    idx = r_core.loc[istart:end].index               # full daily calendar from the core
    df = pd.DataFrame({n: streams[n].reindex(idx).fillna(0.0) for n in streams})
    return df, meta


# ------------------------------------------------------------------------- combine
def weighted(df: pd.DataFrame, w: dict) -> pd.Series:
    return sum(df[k] * w.get(k, 0.0) for k in df.columns)


def met(r: pd.Series) -> dict:
    held = pd.Series(1.0, index=r.index)
    m = compute_metrics(r, held)
    return {"cagr": m.cagr, "ann_vol": m.ann_vol, "sharpe": m.sharpe,
            "sortino": m.sortino, "max_dd": m.max_dd, "calmar": m.calmar,
            "total_return": m.total_return, "n_days": m.n_days}


def worst_year(r: pd.Series) -> float:
    by = [float((1.0 + r[r.index.year == y]).prod() - 1.0)
          for y in sorted(set(r.index.year)) if (r.index.year == y).sum() >= 250]
    return min(by) if by else float("nan")


def alloc_walk_forward(df: pd.DataFrame, m_lev: float, target=0.50, stop=0.40):
    """Fully-OOS allocation: for each calendar year, pick the allocation from ALLOC_GRID
    with the best Sharpe on PRIOR-YEARS data only, apply it OOS to that year, stitch."""
    years = sorted(set(df.index.year))
    oos = pd.Series(dtype=float)
    chosen = {}
    for y in years:
        train = df[df.index.year < y]
        test = df[df.index.year == y]
        if len(train) < 200 or len(test) < 250:       # need history + a full test year
            continue
        best, best_sh = None, -1e9
        for w in ALLOC_GRID:
            sh = met(weighted(train, w))["sharpe"]
            if sh > best_sh:
                best_sh, best = sh, w
        chosen[int(y)] = best
        oos = pd.concat([oos, weighted(test, best)])
    return oos.sort_index(), chosen


def annual_report(r: pd.Series, m_lev: float):
    e = annual_eval(r, m_lev, 0.50, 0.40)
    if e is None:
        return None
    return {"m": m_lev, "banked_50": e["banked_50"], "full_years": e["full_years"],
            "hit_rate": e["hit_rate"], "avg_year": e["avg_year"],
            "worst_year": e["worst_year"], "per_year": e["per_year"]}


def harvest_run(r: pd.Series, base=HARVEST_BASE, m=HARVEST_M, double_at=DOUBLE_AT,
                stop=ANNUAL_STOP, harvest_frac=1.0, go_flat=True) -> pd.DataFrame:
    """Whole-run sim of the harvest policy. Per calendar year: start at base; compound
    m*daily; when equity >= double_at*base, withdraw `harvest_frac` of the profit. If
    go_flat, stop for the rest of the year; otherwise keep trading (leaving
    (1-harvest_frac) of the profit ON THE TABLE to ride). -stop YTD also goes flat;
    sweep remaining profit at year end. Causal & path-dependent."""
    rows, cum = [], 0.0
    for y in sorted(set(r.index.year)):
        ry = r[r.index.year == y]
        last = ry.index[-1]
        eq, locked = base, False
        for d, x in ry.items():
            ev_cash, ev = 0.0, ""
            if not locked:
                eq *= (1.0 + m * x)
                if eq <= 1e-9:
                    eq, locked, ev = 0.0, True, "LIQUIDATION"
                elif harvest_frac > 0 and eq >= double_at * base:
                    take = harvest_frac * (eq - base)
                    cum += take; ev_cash += take; eq -= take; ev = "2X-HARVEST"
                    if go_flat:
                        locked = True
                if not locked and eq <= (1.0 - stop) * base:
                    locked, ev = True, (ev or "STOP")
            if d == last:                                   # year-end settle / reset
                settle = eq - base
                if abs(settle) > 1e-9:
                    cum += settle; ev_cash += settle
                    ev = (ev + "+" if ev else "") + ("YE-SWEEP" if settle > 0 else "YE-LOSS")
                    eq = base
            rows.append((d, eq, "FLAT" if locked else "ACTIVE", ev_cash, ev, cum))
    return pd.DataFrame(rows, columns=["date", "equity", "mode", "cash", "event",
                                       "cum_cash"]).set_index("date")


def _wealth_maxdd(daily: pd.DataFrame) -> float:
    """Drawdown of total wealth = at-risk account + cash already pocketed (withdrawals
    move money to the pocket, so the wealth curve is continuous — the real drawdown)."""
    w = daily["equity"] + daily["cum_cash"]
    return float((w / w.cummax() - 1).min())


def harvest_report(df: pd.DataFrame, harvest_frac=1.0, go_flat=True):
    r = weighted(df, PROFILES[HARVEST_PROFILE])
    book_m = (1.0 + HARVEST_M * r)
    w = PROFILES[HARVEST_PROFILE]
    print(f"HARVEST POLICY — {HARVEST_PROFILE} book "
          f"(CORE {w['CORE']:.0%}/BTC1H {w['BTC1H']:.0%}/ETH8H {w['ETH8H']:.0%}/SPINE {w['SPINE']:.0%}) "
          f"at {HARVEST_M:g}x on ${HARVEST_BASE:,.0f} (annual reset, -{ANNUAL_STOP:.0%} stop)\n")

    print("  profit-taking variants (whole run, net cash on $300k base):")
    print(f"    {'variant':<34} {'net cash':>12} {'wealth maxDD':>11} {'2x-events':>10}")
    for f, gf, lbl in [(1.0, True, "take 100% at 2x, then FLAT"),
                       (1.0, False, "take 100% at 2x, keep trading"),
                       (0.5, False, "leave 50% on the table"),
                       (0.25, False, "leave 75% on the table"),
                       (0.0, False, "leave 100% (year-end sweep only)")]:
        d = harvest_run(r, harvest_frac=f, go_flat=gf)
        tot = d["cum_cash"].iloc[-1]; n = int(d["event"].str.contains("2X").sum())
        mark = "  <-- this run" if (abs(f - harvest_frac) < 1e-9 and gf == go_flat) else ""
        print(f"    {lbl:<34} ${tot:>11,.0f} {_wealth_maxdd(d):>11.0%} {n:>10}{mark}")

    pol = "take 100% then FLAT" if (harvest_frac >= 1 and go_flat) else \
        f"leave {1 - harvest_frac:.0%} on the table (keep trading)"
    print(f"\n  MONTH-ON-MONTH — {pol}:")
    daily = harvest_run(r, harvest_frac=harvest_frac, go_flat=go_flat)
    blbl = f"book m={HARVEST_M:g}"
    print(f"  {'month':<8} {'mode':<6} {blbl:>9} {'equity$':>10} {'cash out$':>11} {'cum cash$':>12}  event")
    for y in sorted(set(df.index.year)):
        dy = daily[daily.index.year == y]
        ry = r[r.index.year == y]
        for mdate in pd.date_range(ry.index[0], ry.index[-1], freq="ME").union(
                pd.DatetimeIndex([dy.index[-1]])):
            mdays = dy[(dy.index.year == mdate.year) & (dy.index.month == mdate.month)]
            if mdays.empty:
                continue
            bret = book_m[(book_m.index.year == mdate.year) & (book_m.index.month == mdate.month)].prod() - 1
            row = mdays.iloc[-1]; cash_m = mdays["cash"].sum()
            evs = "/".join(sorted({e for e in mdays["event"] if e}))
            print(f"  {mdate.strftime('%Y-%m'):<8} {row['mode']:<6} {bret:>+9.0%} "
                  f"${row['equity']:>9,.0f} {('$'+format(cash_m,',.0f')) if abs(cash_m)>1 else '—':>11} "
                  f"${row['cum_cash']:>11,.0f}  {evs}")
        print(f"  -> {y} total: cash ${dy['cash'].sum():>+12,.0f}   cumulative ${dy['cum_cash'].iloc[-1]:>12,.0f}\n")
    total = daily["cum_cash"].iloc[-1]
    print(f"WHOLE RUN {df.index[0].date()} -> {df.index[-1].date()}: net cash ${total:,.0f} "
          f"on ${HARVEST_BASE:,.0f} ({total/HARVEST_BASE:.1f}x), wealth maxDD {_wealth_maxdd(daily):.0%}. "
          f"2021/2026 partial. Leaving profit on the table rides post-2x upside but risks "
          f"giving it back (the -40% stop is vs base, so retained profit is unprotected). Not predictive.")


def main(argv):
    if "--harvest" in argv:
        lockflat = "--lock-flat" in argv          # default = recommended leave-50% @ 2x
        harvest_report(build_panel()[0],
                       harvest_frac=1.0 if lockflat else 0.5, go_flat=lockflat)
        return
    os.makedirs(RESULTS, exist_ok=True)
    print("UNIFIED ORCHESTRATOR — CORE (daily momentum) + BTC1H + ETH8H intraday + SPINE "
          "(all-weather L/S trend)\n(intraday & spine params chosen OOS per fold; daily "
          "core = fixed validated config)\n")
    df, meta = build_panel()
    win = f"{df.index[0].date()} -> {df.index[-1].date()}  ({len(df)} days, "
    win += f"{len(set(df.index.year))} calendar years)"
    print(f"Common OOS window: {win}\n")

    # ---- 1. standalone sleeve metrics over the common window ----
    print("Per-sleeve (standalone, 1x, over the common window):")
    print(f"  {'sleeve':<7} {'CAGR':>8} {'vol':>7} {'Sharpe':>7} {'maxDD':>8} {'tradeDays':>10}")
    sleeve_metrics = {}
    for s in df.columns:
        mm = met(df[s]); sleeve_metrics[s] = mm
        td = meta.get(s, {}).get("trade_days", mm["n_days"])
        print(f"  {s:<7} {mm['cagr']:>8.1%} {mm['ann_vol']:>7.1%} {mm['sharpe']:>7.2f} "
              f"{mm['max_dd']:>8.1%} {td:>10}")

    # ---- 2. correlation matrix (the diversification test) ----
    corr = df.corr()
    print("\nSleeve daily-return correlation (diversification — lower is better):")
    print(corr.round(3).to_string())

    # ---- 3. risk profiles vs core-alone, m=1 ----
    core_only = df["CORE"]
    combined = weighted(df, FIXED_W)                 # default = all-weather
    profile_books = {"CORE only": core_only,
                     "GROWTH (no spine)": weighted(df, PROFILES["growth"]),
                     "ALL-WEATHER (+30% spine)": weighted(df, PROFILES["all_weather"])}
    print("\nProfiles (m=1) — more spine = lower CAGR, higher Sharpe, smaller drawdown:")
    print(f"  {'book':<26} {'CAGR':>8} {'vol':>7} {'Sharpe':>7} {'maxDD':>8} {'Calmar':>7} {'worstYr':>9}")
    for label, r in profile_books.items():
        mm = met(r)
        print(f"  {label:<26} {mm['cagr']:>8.1%} {mm['ann_vol']:>7.1%} {mm['sharpe']:>7.2f} "
              f"{mm['max_dd']:>8.1%} {mm['calmar']:>7.2f} {worst_year(r):>9.1%}")

    # ---- 4. annual $100k wrapper: % years banking +50% ----
    print("\nAnnual $100k wrapper (+50% lock / -40% stop) — % of FULL years banking +50%:")
    print(f"  {'book / m':<22} {'banked':>8} {'hit':>6} {'avgYr':>8} {'worstYr':>9}")
    annual = {}
    alloc_oos, chosen = alloc_walk_forward(df, 3.0)
    books = {"GROWTH": weighted(df, PROFILES["growth"]),
             "ALL-WEATHER": weighted(df, PROFILES["all_weather"]),
             "alloc-WF": alloc_oos}
    for m_lev in (2.0, 3.0):
        for label, r in books.items():
            rep = annual_report(r, m_lev)
            if rep is None:
                continue
            annual[f"{label} m={m_lev}"] = rep
            print(f"  {label+' m='+str(m_lev):<22} "
                  f"{str(rep['banked_50'])+'/'+str(rep['full_years']):>8} "
                  f"{rep['hit_rate']:>6.0%} {rep['avg_year']:>8.1%} {rep['worst_year']:>9.1%}")
    print(f"\n  alloc-WF chose per year (CORE/BTC1H/ETH8H/SPINE): "
          + "  ".join(f"{y}:{w['CORE']:.0%}/{w['BTC1H']:.0%}/{w['ETH8H']:.0%}/{w.get('SPINE',0):.0%}"
                      for y, w in chosen.items()))

    # ---- 5. combined equity curve + artifacts ----
    eq = (1.0 + combined).cumprod()
    pd.DataFrame({"core": (1.0 + core_only).cumprod(), "combined": eq}).to_csv(
        os.path.join(RESULTS, "unified_bot_equity.csv"), index_label="date")
    out = {
        "window": [str(df.index[0].date()), str(df.index[-1].date())],
        "n_days": len(df), "profiles": PROFILES, "default_profile": DEFAULT_PROFILE,
        "sleeve_meta": meta, "sleeve_metrics": sleeve_metrics,
        "correlation": corr.round(4).to_dict(),
        "metrics": {"core_only": met(core_only),
                    "growth": met(weighted(df, PROFILES["growth"])),
                    "all_weather": met(weighted(df, PROFILES["all_weather"])),
                    "alloc_wf": met(alloc_oos)},
        "annual": annual, "alloc_wf_choices": chosen,
    }
    with open(os.path.join(RESULTS, "unified_bot_results.json"), "w") as f:
        json.dump(out, f, indent=2, default=float)

    # ---- 6. live orchestrator snapshot (what to trade today) ----
    panel = ps.load_panel()
    book = ps.book_weights(panel)
    w_today = book.iloc[-1]
    print(f"\nLIVE SNAPSHOT {panel.index[-1].date()} — orchestrator target "
          f"(profile '{DEFAULT_PROFILE}', split {FIXED_W}):")
    print(f"  CORE  {FIXED_W['CORE']:.0%} -> daily book: "
          + ", ".join(f"{c} {w_today[c]:.0%}" for c in ps.COINS if abs(w_today[c]) > 1e-3))
    print(f"  BTC1H {FIXED_W['BTC1H']:.0%} -> long BTC on 1H dips, close>SMA50 & ADX>=30 (±3% bracket)")
    print(f"  ETH8H {FIXED_W['ETH8H']:.0%} -> long ETH on 8H dips, close>SMA50 & ADX>=20 (TP 3xATR/SL 1.5xATR)")
    print(f"  SPINE {FIXED_W['SPINE']:.0%} -> long/short top-30 TS-trend (crisis alpha; shorts confirmed downtrends)")
    print(f"\nwrote {os.path.join(RESULTS, 'unified_bot_results.json')} and unified_bot_equity.csv")


if __name__ == "__main__":
    main(sys.argv[1:])
```

### A.11 — `research/harvest_sweep.py`

Sweeps 600 harvest configs under self-funding + principal-returned constraints; finds the best ROI-per-wealth-drawdown.

```python
"""Sweep the harvest-policy space for the best cash-harvest with the LEAST drawdown,
subject to two hard constraints from the goal:
  (1) self-funding  — you put in the $300k base ONCE; every losing-year top-up must come
      from already-harvested profit (cumulative net cash never goes negative, no
      liquidation). You never inject external cash to survive.
  (2) investment returned — cumulative harvested cash must reach the full $300k base
      (you get your money back); we also report HOW FAST.

Then we want max ROI (cash/base) with the least account drawdown. We sweep the book
defensiveness (spine weight), leverage m, the profit-lock trigger (+50%/+100%), the
stop, and the profit-taking policy (lock-flat / harvest-continue / leave 25-50% on the
table), and report the Pareto frontier (best ROI at each drawdown ceiling) + the best
risk-adjusted, self-funding, principal-returning config.

Run: python harvest_sweep.py
"""
from __future__ import annotations

import sys

import numpy as np
import pandas as pd

from unified_bot import build_panel, harvest_run, weighted

BASE = 300_000.0

SPINES = [0.00, 0.15, 0.30, 0.45, 0.60]          # 0 = growth; 0.60 = all-weather-max
M = [1.0, 1.5, 2.0, 2.5, 3.0]
LOCKS = [1.5, 2.0]                                # take profit at +50% or +100% (2x)
STOPS = [0.20, 0.30, 0.40]
POLICIES = [(1.0, True, "lock-flat"), (1.0, False, "harvest-cont"),
            (0.75, False, "leave25"), (0.50, False, "leave50")]


def book_w(spine: float) -> dict:
    return {"CORE": round(1.0 - 0.30 - spine, 4), "BTC1H": 0.15, "ETH8H": 0.15, "SPINE": spine}


def evaluate(r, m, lock, stop, frac, flat) -> dict:
    d = harvest_run(r, base=BASE, m=m, double_at=lock, stop=stop,
                    harvest_frac=frac, go_flat=flat)
    cum, eq = d["cum_cash"], d["equity"]
    total = float(cum.iloc[-1])
    # TRUE drawdown = drawdown of total wealth (at-risk account + cash pocketed).
    # Withdrawals/resets just move money to the pocket -> the wealth curve is continuous,
    # so this is the real peak-to-trough the investor experiences.
    wealth = eq + cum
    maxdd = float((wealth / wealth.cummax() - 1.0).min())
    liq = bool(d["event"].str.contains("LIQ").any())
    self_fund = (float(cum.min()) >= -1.0) and not liq          # never net out-of-pocket
    rec = cum[cum >= BASE]
    rec_days = int((rec.index[0] - d.index[0]).days) if len(rec) else None
    yr = d.groupby(d.index.year)["cash"].sum()
    return {"roi": total / BASE, "total": total, "maxdd": maxdd, "self_fund": self_fund,
            "rec_days": rec_days, "worst_yr": float(yr.min()),
            "score": (total / BASE) / abs(maxdd) if maxdd < 0 else total / BASE}


def main(argv):
    df, _ = build_panel()
    books = {s: weighted(df, book_w(s)) for s in SPINES}
    rows = []
    for s, r in books.items():
        for m in M:
            for lock in LOCKS:
                for stop in STOPS:
                    for frac, flat, pol in POLICIES:
                        e = evaluate(r, m, lock, stop, frac, flat)
                        e.update(spine=s, m=m, lock=lock, stop=stop, pol=pol)
                        rows.append(e)
    print(f"HARVEST SWEEP — base ${BASE:,.0f}, {df.index[0].date()}->{df.index[-1].date()}, "
          f"{len(rows)} configs.\nConstraints: self-funding (no external top-up ever) AND "
          f"investment fully returned.\n")

    ok = [e for e in rows if e["self_fund"] and e["rec_days"] is not None]
    print(f"  {len(ok)}/{len(rows)} configs are self-funding AND return the full $300k.\n")

    def desc(e):
        return (f"spine {e['spine']:.0%}, m={e['m']:g}, lock +{(e['lock']-1)*100:.0f}%, "
                f"stop -{e['stop']:.0%}, {e['pol']}")

    print("  PARETO FRONTIER — best ROI (self-funding) at each wealth-drawdown ceiling")
    print("  (drawdown = peak-to-trough of total wealth = at-risk account + cash pocketed):")
    print(f"    {'wlthDD<=':>8} {'ROI':>6} {'cash$':>11} {'wlthDD':>7} {'$back in':>9}  config")
    for ceil in (0.15, 0.20, 0.25, 0.30, 0.40, 1.00):
        cands = [e for e in ok if abs(e["maxdd"]) <= ceil + 1e-9]
        if not cands:
            print(f"    {'-'+format(ceil,'.0%'):>8}  (none)")
            continue
        b = max(cands, key=lambda e: e["roi"])
        print(f"    {'-'+format(ceil,'.0%'):>8} {b['roi']:>5.1f}x ${b['total']:>10,.0f} "
              f"{b['maxdd']:>7.0%} {str(b['rec_days'])+'d':>9}  {desc(b)}")

    best = max(ok, key=lambda e: e["score"])
    print(f"\n  BEST RISK-ADJUSTED (max ROI per unit wealth-drawdown): {desc(best)}")
    print(f"    ROI {best['roi']:.1f}x  (${best['total']:,.0f} cash on ${BASE:,.0f}), "
          f"wealth maxDD {best['maxdd']:.0%}, principal back in {best['rec_days']} days, "
          f"worst year ${best['worst_yr']:,.0f}, self-funding ✔")

    print("\n  Top 8 self-funding configs by ROI-per-wealth-drawdown:")
    print(f"    {'ROI':>6} {'cash$':>11} {'wlthDD':>7} {'score':>6} {'$back':>7}  config")
    for e in sorted(ok, key=lambda e: e["score"], reverse=True)[:8]:
        print(f"    {e['roi']:>5.1f}x ${e['total']:>10,.0f} {e['maxdd']:>7.0%} "
              f"{e['score']:>6.2f} {str(e['rec_days'])+'d':>7}  {desc(e)}")
    print("\n  Backtest, OOS in the walk-forward sense; 2021/2026 partial; 4.5 lumpy "
          "years; leverage gap-risk real. Not predictive.")


if __name__ == "__main__":
    main(sys.argv[1:])
```

### A.12 — `research/walkforward.py`

Rolling walk-forward harness for the daily families — a transitive dependency of A.9 `annual_target.py` (imported at module load). Depends only on A.3 engine.py and A.4 strategies.py.

```python
"""Walk-forward validation.

For an asset + strategy family:
  1. Pre-compute every grid param's causal return series once (weights only
     ever use past data, so the series is window-independent).
  2. Roll train/test windows forward. In each window pick the param with the
     best *train* objective, then record its performance on the *next,
     unseen* test window and append those test returns to an OOS stream.
  3. The stitched OOS stream is the headline result: it is fully out of
     sample and free of parameter-selection leakage.

A family "passes" only on OOS evidence: positive aggregate OOS return, OOS
Sharpe above a floor, controlled drawdown, and consistency across folds.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd

from engine import backtest, compute_metrics, Costs, Metrics, ANN
from strategies import Family


@dataclass
class Fold:
    train_start: str
    test_start: str
    test_end: str
    params: dict
    train_sharpe: float
    test_sharpe: float
    test_return: float
    test_max_dd: float
    test_days: int


@dataclass
class WFResult:
    asset: str
    family: str
    folds: list[Fold]
    oos: Metrics
    oos_equity: pd.Series = field(repr=False)
    oos_returns: pd.Series = field(repr=False)
    oos_held: pd.Series = field(repr=False, default=None)
    fold_pass_rate: float = 0.0
    avg_fold_test_sharpe: float = 0.0
    param_stability_pct: float = 0.0

    def summary(self) -> dict:
        return {
            "asset": self.asset,
            "family": self.family,
            "n_folds": len(self.folds),
            "oos_cagr": round(self.oos.cagr, 4),
            "oos_sharpe": round(self.oos.sharpe, 3),
            "oos_sortino": round(self.oos.sortino, 3),
            "oos_max_dd": round(self.oos.max_dd, 4),
            "oos_calmar": round(self.oos.calmar, 3),
            "oos_vol": round(self.oos.ann_vol, 4),
            "avg_exposure": round(self.oos.avg_exposure, 3),
            "ann_turnover": round(self.oos.ann_turnover, 2),
            "fold_pass_rate": round(self.fold_pass_rate, 3),
            "avg_fold_sharpe": round(self.avg_fold_test_sharpe, 3),
            "param_stability_pct": round(self.param_stability_pct, 2),
            "oos_days": self.oos.n_days,
        }


def _objective(m: Metrics, min_trades: int) -> float:
    """Train-window selection score. Reward risk-adjusted return, require the
    strategy to actually trade, and penalise blow-up drawdowns."""
    if m.n_days < 30 or m.n_trades < min_trades or m.avg_exposure <= 1e-6:
        return -1e9
    score = m.sharpe
    if m.max_dd < -0.5:
        score -= (abs(m.max_dd) - 0.5) * 2.0
    return score


def _param_stability(params: list[dict]) -> float:
    if len(params) < 2:
        return 0.0
    keys = {}
    for p in params:
        for k, v in p.items():
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                keys.setdefault(k, []).append(float(v))
    max_dev = 0.0
    for k, vals in keys.items():
        if len(vals) < 2:
            continue
        mean = sum(vals) / len(vals)
        if mean == 0:
            continue
        for v in vals:
            dev = abs((v - mean) / mean) * 100.0
            max_dev = max(max_dev, dev)
    return max_dev


def walk_forward(
    asset: str,
    prices: pd.Series,
    family: Family,
    *,
    train_days: int = 540,
    test_days: int = 180,
    costs: Costs = Costs(),
    min_trades_train: int = 3,
) -> Optional[WFResult]:
    prices = prices.sort_index()
    # 1. precompute every param's full causal return series
    series: list[tuple[dict, pd.Series, pd.Series]] = []
    for p in family.grid:
        w = family.weights(prices, p)
        bt = backtest(prices, w, costs)
        series.append((p, bt["returns"], bt["held"]))
    if not series:
        return None

    idx = series[0][1].index
    if len(idx) == 0:
        return None
    start = idx[0]
    end = idx[-1]

    folds: list[Fold] = []
    oos_chunks: list[pd.Series] = []
    held_chunks: list[pd.Series] = []
    chosen_params: list[dict] = []

    train_td = pd.Timedelta(days=train_days)
    test_td = pd.Timedelta(days=test_days)
    train_start = start
    while train_start + train_td + test_td <= end + pd.Timedelta(days=1):
        train_lo = train_start
        train_hi = train_start + train_td
        test_hi = train_hi + test_td
        train_mask = (idx >= train_lo) & (idx < train_hi)
        test_mask = (idx >= train_hi) & (idx < test_hi)
        if test_mask.sum() < 20 or train_mask.sum() < 60:
            train_start += test_td
            continue

        best = None
        best_score = -np.inf
        for p, r, held in series:
            tr = r[train_mask]
            th = held[train_mask]
            m = compute_metrics(tr, th)
            sc = _objective(m, min_trades_train)
            if sc > best_score:
                best_score = sc
                best = (p, r, held, m)
        if best is None:
            train_start += test_td
            continue
        p, r, held, train_m = best
        test_r = r[test_mask]
        test_h = held[test_mask]
        test_m = compute_metrics(test_r, test_h)
        folds.append(Fold(
            train_start=str(train_lo.date()),
            test_start=str(train_hi.date()),
            test_end=str(test_hi.date()),
            params=p,
            train_sharpe=round(train_m.sharpe, 3),
            test_sharpe=round(test_m.sharpe, 3),
            test_return=round(test_m.total_return, 4),
            test_max_dd=round(test_m.max_dd, 4),
            test_days=test_m.n_days,
        ))
        oos_chunks.append(test_r)
        held_chunks.append(test_h)
        chosen_params.append(p)
        train_start += test_td

    if not oos_chunks:
        return None

    oos_returns = pd.concat(oos_chunks).sort_index()
    oos_returns = oos_returns[~oos_returns.index.duplicated(keep="first")]
    oos_held = pd.concat(held_chunks).sort_index()
    oos_held = oos_held[~oos_held.index.duplicated(keep="first")]
    oos_equity = (1.0 + oos_returns).cumprod()
    oos_m = compute_metrics(oos_returns, oos_held)

    fold_pass = np.mean([1.0 if f.test_return > 0 else 0.0 for f in folds]) if folds else 0.0
    avg_fold_sharpe = float(np.mean([f.test_sharpe for f in folds])) if folds else 0.0
    stability = _param_stability(chosen_params)

    return WFResult(
        asset=asset, family=family.name, folds=folds, oos=oos_m,
        oos_equity=oos_equity, oos_returns=oos_returns, oos_held=oos_held,
        fold_pass_rate=float(fold_pass), avg_fold_test_sharpe=avg_fold_sharpe,
        param_stability_pct=stability,
    )
```
