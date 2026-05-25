# Software Specification — Asset-Specific Crypto Trading System

**Project:** systematic crypto strategy discovery + walk-forward validation harness
(`research/`), built to find per-coin strategies for the requested universe
**SOL, ETH, BTC, DOGE, XRP** (plus ADA, BNB, LINK, LTC, DOT as breadth) and validate
them out-of-sample.
**Status:** research complete; all results below are walk-forward out-of-sample (OOS).
**Date:** 2026-05-25.

> **Honesty banner (read first).** The headline objective — **+50% in *every*
> calendar year** — is **not achievable with honest out-of-sample evidence** for
> these assets, and high leverage makes year-on-year consistency *worse* (it
> creates account-destroying years). The best validated configuration banks +50%
> in **~80% of years** (diversified book) / **70–88% per single coin**. This spec
> documents exactly how that was established and the precise strategy that comes
> closest. No parameters were fit to the missing years (2023, 2025); doing so
> would be overfitting that loses money live.
>
> **2026-05-25 update — two prior blockers removed, conclusion unchanged.** The
> environment can now reach `data-api.binance.vision` (Binance's public
> market-data mirror) and `api.kucoin.com`, so the two caveats the earlier
> research leaned on were closed: (1) **real SOL** daily/intraday now replaces the
> DOT stand-in, and (2) **real 1h intraday** candles let us test mean reversion at
> the frequency where it actually has opportunities. On the *exact* SOL/ETH/BTC/
> DOGE/XRP universe the trend book still banks +50% in **8/10 years (80%)**.
> Adding a **cross-sectional (relative-value) momentum** sleeve — which the 5-coin
> panel makes possible and which banks exactly the trendless years (2023, 2025)
> that absolute trend misses — lifts the blended book to **9/10 years (90%)**,
> robust across a wide weight band, with **2022** (the LUNA/3AC/FTX crash) the lone
> miss. A dense simplex search proves **no static blend reaches 10/10**: the sleeve
> that banks 2022 (a short/regime sleeve) loses 2023, and vice-versa — the
> rescuing sleeves are mutually exclusive in the contested years. The intraday-MR
> sleeve is genuinely uncorrelated (corr +0.07) but cost-bound and does not lift
> the ceiling. **Net: the new data + a new return source improved honest
> consistency from 80% → 90%; +50% *every* year remains unattainable OOS without
> overfitting.** See §12.6–12.9 and §14.

## Table of contents
- [1. Objective & scope](#1-objective)
- [2. System architecture](#2-architecture)
- [3. Data layer](#3-data)
- [4. Backtest engine (exact formulas)](#4-engine)
- [5. Cost & leverage model](#5-costs)
- [6. Strategy library (exact definitions)](#6-strategies)
- [7. Volatility targeting & position sizing](#7-sizing)
- [8. Regime orchestrator](#8-orchestrator)
- [9. Risk overlays: annual reset, profit-lock, circuit breaker](#9-overlays)
- [10. Walk-forward / OOS methodology](#10-walkforward)
- [11. Process log — exact steps taken](#11-process)
- [12. Walk-forward OOS results (precise)](#12-results)
- [13. The strategy that works best year-on-year (precise spec)](#13-winner)
- [14. Verdict on the 50%/yr objective](#14-verdict)
- [15. Deployment architecture](#15-deployment)
- [16. Limitations & caveats](#16-caveats)
- [17. File index & reproduction](#17-files)

---

## 1. Objective

Find, **per coin**, the strategy (or a regime orchestrator) that maximises the
number of calendar years returning **≥ +50%** on a **$100,000 account that is
reset every January** (profit withdrawn at year end), allowed to use **futures
leverage**, validated with **walk-forward out-of-sample** testing. Long or short.

Two studies were run:
- **30% study** (`run_research.py`): risk-controlled, ≤3× leverage, target 30% CAGR.
- **50% study** (`run_v2.py`, `annual_target.py`): futures leverage + orchestrator
  + annual profit-lock, target +50%/yr.

---

## 2. Architecture

```
            ┌─────────────┐
 GitHub ───▶│ data.py     │  daily close prices (Coin Metrics community)
 raw CSV    └──────┬──────┘  cached -> research/data/<SYM>_daily.csv
                   │
                   ▼
        ┌──────────────────────┐   indicators: EMA/SMA/RSI/σ  (all causal)
        │ strategies.py        │   families: tsmom, tsmom_blend, macross,
        │  signal -> raw[-1,1] │   donchian, trend_flat, mr_z, rsi_mr,
        └──────────┬───────────┘   orchestrator
                   │ build_weights() = vol-target + leverage cap + long_only
                   ▼
        ┌──────────────────────┐   held[t]=w[t-1]; P&L net of txn+funding
        │ engine.py backtest()  │   metrics: CAGR/Sharpe/Sortino/maxDD/Calmar
        └──────────┬───────────┘
                   │
                   ▼
        ┌──────────────────────┐   rolling train→test, non-overlapping,
        │ walkforward.py        │   param chosen on TRAIN only, OOS stitched
        └──────────┬───────────┘
                   │
       ┌───────────┼─────────────────────────┐
       ▼           ▼                          ▼
 run_research.py  run_v2.py            annual_target.py
 (30% study,      (leverage+orch+      (annual profit-lock +
  portfolios)      circuit breaker)     diversified books)
```

Risk overlays applied on the OOS return stream (all causal):
`apply_annual_breaker` (engine.py), `simulate_year` profit-lock (annual_target.py).

---

## 3. Data

| Item | Spec |
| --- | --- |
| **Source** | (a) Coin Metrics *community* network data for the long-history coins (`raw.githubusercontent.com/coinmetrics/data/master/csv/<asset>.csv`); (b) **`data-api.binance.vision`** (Binance public market-data mirror) for **SOL** daily and for **all-coin 1h intraday**. |
| **Field** | Daily close = `PriceUSD`/`ReferenceRateUSD` (Coin Metrics) or `close` from Binance klines (SOL). |
| **Frequency** | **Daily** (1 bar/day, UTC) for the validated trend study; **1H intraday** now also fetched (`research/data/intraday/<SYM>_1h.csv`, ~52k bars/coin, 2020→2026) for the mean-reversion study (§12.7). |
| **Reachability (2026-05-25)** | `data-api.binance.vision` → **200 OK**; `api.kucoin.com` → **200 OK**. `api.binance.com` → **451** (geo-blocked), `api.binance.us` → 403. So market data flows via the Binance mirror / KuCoin; signed/account/trading endpoints remain unavailable here. Loaders: [`binance_vision.py`](research/binance_vision.py) (primary), [`kucoin_loader.py`](research/kucoin_loader.py) (alt). |
| **Coverage** | BTC 2014‑01‑01→, ETH 2016‑06‑01→, **SOL 2020‑08‑11→ (real, Binance)**, XRP 2014‑08‑15→, DOGE 2015‑01‑01→, LTC 2013→, ADA/BNB/LINK 2017→, DOT 2020→. All to 2026‑05‑25. |
| **Cleaning** | drop null/≤0 prices, dedupe by date, sort ascending; cached as slim `date,close,volume_usd` CSVs in `research/data/`. |

**SOL note (resolved):** SOL is no longer a Coin Metrics 7-row stub problem —
real SOLUSDT history (2020‑08‑11→) is sourced from the Binance mirror. DOT is
retained only as extra breadth, not as the SOL proxy.

---

## 4. Engine

`engine.py::backtest(prices, target_w, costs)`. **Strictly lookahead-free.**

Let `P[t]` = close, `w[t]` = target weight decided at close of day *t* (signed
leverage). Definitions (annualisation factor **ANN = 365**):

```
ret[t]      = P[t]/P[t-1] - 1
held[t]     = w[t-1]                       # weight in force during day t
turnover[t] = |held[t] - held[t-1]|
gross[t]    = held[t] * ret[t]
cost[t]     = txn * turnover[t] + funding_daily * |held[t]|
r_p[t]      = gross[t] - cost[t]           # realised portfolio return, day t
equity[t]   = Π (1 + r_p[t])
```

Metrics:
```
CAGR    = equity_end^(365/n_days) - 1
ann_vol = std(r_p) * sqrt(365)
Sharpe  = mean(r_p)/std(r_p) * sqrt(365)
Sortino = mean(r_p)/std(r_p[r_p<0]) * sqrt(365)
maxDD   = min(equity / cummax(equity) - 1)
Calmar  = CAGR / |maxDD|
```
`r_p[0]` (no prior price) is dropped. Weights are shifted by one day before being
applied, so a signal computed at close *t* can only earn day *t+1* — no leakage.

---

## 5. Costs & leverage

| Parameter | 30% study | 50% study |
| --- | --- | --- |
| `txn` (per side, on turnover) | 6 bps (0.0006) | 6 bps |
| `funding_daily` (per unit gross/day) | 0.5 bps (0.00005) | 1.0 bps (0.0001) |
| stress-test costs | up to 25 bps/side + 2 bps/day | — |

**Leverage model.** A strategy's *net* daily return scales linearly with size
(gross, txn and funding all scale with notional), so running the engine at `m×`
size ≡ multiplying its net daily returns by `m`. The exchange's 10–50× facility
sets *margin*; **effective exposure** = notional ÷ equity = `|held[t]|` is what
drives P&L and liquidation. A day where `1 + m·ret ≤ 0` is a **liquidation**
(that year = −100%).

---

## 6. Strategies

Every family produces a **causal raw signal in [−1, +1]**, then `build_weights`
(§7) turns it into a sized target weight. Indicators: `EMA(span)`, `SMA(n)`,
`rolling_std(n)`, `RSI(n)`, `realized_vol(n)=std(ret,n)·√365`.

| Family | Raw signal (causal) | Key params |
| --- | --- | --- |
| `tsmom` | `sign(P_t / P_{t−L} − 1)` | `lookback L` |
| **`tsmom_blend`** | `mean_{L∈lbs} sign(P_t / P_{t−L} − 1)` ∈[−1,1] | `lbs` (set of horizons) |
| `macross` | `sign(EMA_fast − EMA_slow)` | `fast, slow` |
| `donchian` | long if `P_t > max(P[t−entry..t−1])`; short if `P_t < min(P[t−exit..t−1])`; hold between (ffill) | `entry, exit` |
| `trend_flat` | `+1` if `EMA_f/EMA_s−1 > band`; `−1` if `< −band`; else `0` | `fast, slow, band` |
| `mr_z` | z=`(P−SMA_lb)/σ_lb`; short if `z>z_entry`, long if `z<−z_entry`, flat if `|z|<z_exit`; **gated off** when `|EMA20/EMA100−1|≥trend_gate` | `lb, z_entry, z_exit, trend_gate` |
| `rsi_mr` | long if `RSI<lo`, short if `RSI>hi`, flat 45–55; trend-gated | `lb, lo, hi, trend_gate` |
| **`orchestrator`** | see §8 | regime + trend + MR params |

The decisive empirical finding: **`tsmom_blend` (multi-lookback momentum
consensus), long-only, is the most robust engine** — selected for BTC, ETH, DOGE
in both studies; `donchian` for ADA/BNB; mean-reversion only for the laggards.

---

## 7. Sizing

`strategies.py::build_weights(prices, raw, p)`:

```
realized_vol[t] = std(ret, vol_lb) * sqrt(365)      # causal
rv = max(realized_vol[t], VOL_FLOOR=0.10)           # avoid blow-up in calm
if vol_target > 0:
    scale[t] = min(vol_target / rv, max_lev)
    w[t]     = raw[t] * scale[t]
else:
    w[t]     = raw[t] * max_lev
if long_only: w[t] = max(w[t], 0)
w[t] = clip(w[t], -max_lev, max_lev)
```

So exposure is **inverse-volatility scaled** to a target annualised vol, capped at
`max_lev`. Leverage is used *opportunistically* (more in calm regimes), never
constant. Walk-forward consistently chose modest sizing (avg effective leverage
0.2–0.9×) even with `max_lev=10` available, because higher constant leverage loses
the account out-of-sample.

---

## 8. Orchestrator

`strategies.py::sig_orchestrator` — one model that switches sub-strategy by regime:

```
regime classification (classify_regime):
   spread = EMA_fast/EMA_slow − 1
   UPTREND  (+1): spread >  band  AND  P > SMA_long_ma
   DOWNTREND(−1): spread < −band  AND  P < SMA_long_ma
   CHOP      (0): otherwise

trend_sub = mean_{L∈lbs} sign(P_t/P_{t−L} − 1)
mr_sub    = −1 if z>z_entry ; +1 if z<−z_entry ; else 0     (z over mr_lb)

raw[t] = trend_sub  clipped ≥0   in UPTREND      (long the trend)
       = trend_sub  clipped ≤0   in DOWNTREND    (short the bear)
       = mr_sub * mr_scale       in CHOP         (fade the range)
```
Default params searched: `fast∈{15,20,25}`, `slow∈{50,60,75}`, `long_ma∈{100,150,200}`,
`band∈{0,0.02}`, `lbs=(20,40,80)`, `mr_lb∈{12,20}`, `z_entry∈{1.3,1.8}`, `mr_scale=0.7`.
It won BTC's risk-adjusted ranking but did **not** beat long-only momentum on raw
return for ETH/DOGE.

---

## 9. Risk overlays

All causal, applied on the OOS return stream:

1. **Annual reset / profit withdrawal** (the brief's model): each calendar year
   starts at equity 1.0 ($100k); year return is computed independently. A bad year
   cannot compound into the next.

2. **Within-year profit-target lock** (`annual_target.py::simulate_year`):
   ```
   eq=1; for each day in year:
       eq *= (1 + m*ret)
       if eq <= 0:           return -1.0        # liquidation
       if eq-1 >= +TARGET:   bank, flat rest of year   (TARGET=0.50)
       if eq-1 <= -STOP:     stop, flat rest of year    (STOP=0.40)
   ```
   This exploits the profit-withdrawal model: once +50% is banked, stop risking it.

3. **Within-year circuit breaker** (`engine.py::apply_annual_breaker`): if YTD
   equity falls `dd_stop` (35%) below its intra-year peak, go flat for the rest of
   the year. Roughly **halves worst-year losses** (BTC −43%→−28%; XRP −112%→−38%),
   converting ruin into a survivable dip.

---

## 10. Walk-forward

`walkforward.py::walk_forward`. Procedure:

1. For each parameter set in the family grid, compute the **full causal return
   series once** (weights only use past data ⇒ window-independent).
2. Roll windows over the date range:
   ```
   span ≥ 2200d  →  train 540d / test 180d
   span ≥ 1400d  →  train 420d / test 150d
   else          →  train 365d / test 120d
   step = test window  (NON-overlapping test windows)
   ```
3. In each window, pick the param maximising the **train-slice objective**:
   ```
   objective = −1e9            if n_days<30 or n_trades<min_trades or exposure≈0
             = Sharpe_train     otherwise
             = Sharpe_train − 2·(|maxDD|−0.5)   if maxDD < −0.5   (blow-up penalty)
   ```
4. Run that param on the **next, unseen** test slice; append test returns to the
   OOS stream. **No parameter is ever scored on data used to select it.**
5. The stitched OOS stream → headline metrics + per-year breakdown.

**Acceptance gate (30% study):** OOS Sharpe ≥ 0.8 AND CAGR ≥ 30% AND fold-win ≥ 0.55
AND maxDD ≥ −55%. **50% study:** count of full calendar years with return ≥ +50%.

---

## 11. Process — exact steps taken

1. **Recon.** Probed network: exchange APIs (Binance/Coinbase/Kraken/CoinGecko/
   KuCoin) and CDNs all return 403; only GitHub/PyPI/npm reachable. ⇒ use Coin
   Metrics daily CSVs from GitHub; intraday impossible.
2. **Data layer.** Built `data.py`; cached 9 assets' daily closes.
3. **Engine.** Built `engine.py` (lookahead-free daily backtest, cost model, metrics).
4. **Strategy library.** Built `strategies.py` (7 families + vol-target overlay).
5. **Walk-forward.** Built `walkforward.py` (rolling train/test, OOS stitching, gate).
6. **30% study** (`run_research.py`): swept all families × all assets; ranked by a
   composite; selected per-asset winner; built equal-weight portfolios. Result:
   5/9 assets clear 30% standalone; **all-9 book +33.6% CAGR / Sharpe 1.72**.
7. **Robustness** (`robustness.py`): cost ladder (6→25 bps) + per-year breakdown.
   Edge survives stress costs; strategies ≈flat in 2018/2022 bears (vs −60–80% B&H).
8. **50% study, v2** (`run_v2.py`): added the **orchestrator**, a 10× leverage
   ladder, long/short, and the **circuit breaker**; computed per-year on the
   $100k-reset model. Result: per-coin 50% hit-rate 70–88% (BTC 6/10 raw), and the
   finding that **leverage worsens consistency** (XRP −112% ruin year).
9. **50% study, v3** (`annual_target.py`): added the **annual profit-target lock**
   (+50% lock / −40% stop) and a **leverage sweep**; tested single coins and
   **diversified books** (3, 4, 9 coins). Result: **BTC+ETH+DOGE book at 3×: 8/10
   years ≥+50%**, incl. 2018 & 2022 bears. Wider 9-coin book is *worse* (8/11).
10. **KuCoin loader** (`kucoin_loader.py`): built + verified it detects the 403
    block; ready to fetch 1H/8H when the host is allowlisted.
11. **Data unblocked (2026-05-25).** Re-probed network: `data-api.binance.vision`
    and `api.kucoin.com` now return 200 (`api.binance.com` is geo-blocked, 451).
    Built [`binance_vision.py`](research/binance_vision.py); fetched **real SOL
    daily** and **1h intraday** for all 5 coins; wired SOL into `data.py`.
12. **Real-SOL re-run** (`annual_target.py`, universe = SOL ETH BTC DOGE XRP):
    best book 8/10 years (80%) — same band as the DOT-proxy study (§12.6).
13. **Intraday-MR study** (`intraday.py`) + **trend/MR blend** (`combine.py`):
    intraday MR is uncorrelated (+0.07) and positive in 2023 but net-negative after
    costs; blending only reshuffles the missed years, ceiling stays 8/10 (§12.7).
14. **Conclusion.** ~80% of years is the honest ceiling; +50% every year is not
    attainable OOS without overfitting (refused). The two prior "if only we had
    real SOL / intraday" caveats are now closed and the conclusion is unchanged.

---

## 12. Results (walk-forward OOS)

### 12.1 — 30% study, per-asset winners (≤3× leverage, vol-targeted)
| Asset | Engine | OOS CAGR | Sharpe | maxDD | Fold-win | Gate |
| --- | --- | ---: | ---: | ---: | ---: | :--: |
| BTC | tsmom_blend | +76.2% | 1.45 | −50.3% | 0.64 | ✅ |
| BNB | donchian | +42.5% | 1.17 | −34.3% | 0.64 | ✅ |
| ETH | tsmom_blend | +35.7% | 1.08 | −40.1% | 0.65 | ✅ |
| DOGE | tsmom_blend | +35.2% | 0.96 | −43.0% | 0.65 | ✅ |
| ADA | donchian | +35.1% | 1.02 | −33.8% | 0.57 | ✅ |
| LINK | trend_flat | +22.8% | 0.84 | −45.6% | 0.57 | ✗ |
| LTC | mr_z | +3.1% | 0.27 | −28.3% | 0.48 | ✗ |
| XRP | rsi_mr | +3.0% | 0.25 | −62.9% | 0.70 | ✗ |
| DOT | donchian | +1.0% | 0.20 | −41.5% | 0.46 | ✗ |

**Portfolios (equal-weight, all OOS):** all-9 → **CAGR +33.6%, Sharpe 1.72,
Sortino 2.14, maxDD −28.4%, positive 10/13 yrs**; pass-only (BTC ETH ADA DOGE BNB)
→ +58.5%, Sharpe 1.62, maxDD −50.3%.

### 12.2 — Cost sensitivity (30% study; OOS CAGR / Sharpe)
| Asset | 6 bps | 12 bps | 15 bps | 25 bps (stress) |
| --- | --- | --- | --- | --- |
| BTC | +76.2/1.45 | +58.5/1.23 | +59.6/1.26 | +74.6/1.31 |
| BNB | +42.5/1.17 | +41.5/1.21 | +36.9/1.09 | +33.4/1.01 |
| ADA | +35.1/1.02 | +42.9/1.16 | +36.0/1.12 | +24.2/0.90 |
| DOGE | +35.2/0.96 | +42.1/0.94 | +42.4/0.94 | +28.8/0.86 |
| ETH | +35.7/1.08 | +19.7/0.80 | +27.9/0.89 | +14.1/0.55 |

### 12.3 — 50% study, per-coin (leverage engine, raw, no lock)
| Coin | Engine | OOS CAGR | Sharpe | maxDD | Years ≥50% |
| --- | --- | ---: | ---: | ---: | :--: |
| BTC | tsmom_blend (m≤10, vt 0.6) | +101.9% | 1.55 | −60.7% | 6/10 |
| DOGE | tsmom_blend | +56.5% | 1.00 | −48.6% | 4/9 |
| ETH | tsmom_blend | +56.4% | 1.20 | −42.2% | 3/8 |
| XRP | donchian | −100%* | 0.16 | −132.9% | 3/10 |

\* XRP hits a < −100% year (liquidation) — leverage ruin.

### 12.4 — 50% study, annual profit-target lock (+50% lock, −40% stop)
Per-coin best leverage `m`, banked = full years returning ≥+50%:

| Coin | Engine | m | Banked ≥50% | Worst yr | Avg profit/yr |
| --- | --- | :--: | :--: | ---: | ---: |
| ETH | tsmom_blend | 3× | **7/8 (88%)** | −43% | $56,056 |
| DOGE | tsmom_blend | 2× | **7/9 (78%)** | −48% | $50,808 |
| BTC | orchestrator | 2× | **7/10 (70%)** | −47% | $32,905 |
| BNB | tsmom_blend | 3× | 5/7 (71%) | −42% | $41,067 |
| LINK | tsmom_blend | 2× | 5/7 (71%) | −46% | $38,405 |
| ADA | tsmom_blend | 1× | 4/6 (67%) | −17% | $32,339 |
| DOT | mr_z | 3× | 2/4 (50%) | −46% | $5,585 |
| XRP | tsmom_blend | 1× | 4/10 (40%) | −43% | $5,280 |
| LTC | tsmom_blend | 1× | 3/11 (27%) | −42% | −$4,863 |

### 12.5 — Diversified books (+50% lock at book level) ⭐ best consistency
| Book | m | Banked ≥50% | Worst yr | Avg profit/yr |
| --- | :--: | :--: | ---: | ---: |
| **BTC+ETH+DOGE** | 3× | **8/10 (80%)** | −43% | **$48,961** |
| BTC+ETH+XRP+DOGE | 20× | 7/10 (70%) | −49% | $78,403 |
| 9-coin universe | 35× | 8/11 (73%) | −43% | $73,497 |

**BTC+ETH+DOGE book per-year OOS (3×, +50% lock):**
2016 +71%✅ · 2017 +56%✅ · **2018 +50%✅** · 2019 +171%✅ · 2020 +50%✅ ·
2021 +67%✅ · **2022 +54%✅** · 2023 −43% · 2024 +53%✅ · 2025 −41%.
→ **8/10 years, including both bear markets (2018, 2022).**

### 12.6 — Real SOL, exact requested universe (2026-05-25 re-run, +50% lock)
With real SOL replacing DOT and the universe set to exactly **SOL ETH BTC DOGE XRP**
([`annual_target.py`](research/annual_target.py)):

| Coin | Engine | m | Banked ≥50% | Worst yr | Avg profit/yr |
| --- | --- | :--: | :--: | ---: | ---: |
| ETH | tsmom_blend | 3× | **7/8 (88%)** | −43% | $56,056 |
| DOGE | tsmom_blend | 2× | **7/9 (78%)** | −48% | $50,808 |
| SOL *(real)* | tsmom_blend | 3× | 3/4 (75%) | −54% | $33,886 |
| BTC | orchestrator | 2× | 7/10 (70%) | −47% | $32,905 |
| XRP | tsmom_blend | 1× | 4/10 (40%) | −43% | $5,280 |

| Book (3×, banked at book level) | Banked ≥50% | Worst yr | Avg profit/yr |
| --- | :--: | ---: | ---: |
| **SOL+ETH+BTC** | **8/10 (80%)** | −40% | $45,016 |
| **BTC+ETH+SOL+DOGE** | **8/10 (80%)** | −40% | $54,617 |
| **All 5 (SOL ETH BTC DOGE XRP)** | **8/10 (80%)** | −44% | $48,606 |

**SOL+ETH+BTC per-year OOS (3×, +50% lock):** 2016 +71%✅ · 2017 +84%✅ ·
2018 +59%✅ · 2019 +57%✅ · 2020 +56%✅ · 2021 +84%✅ · **2022 +54%✅** ·
2023 −40% · 2024 +64%✅ · 2025 −40%. → **8/10, including the 2022 bear.**
(SOL contributes from 2021; pre-2021 years are the BTC/ETH legs.)

The real-SOL universe lands in the **same 80% band** as the DOT-proxy study — the
high-beta-L1 thesis held, and using the genuine asset did not move the ceiling.

### 12.7 — Intraday mean-reversion sleeve + trend/MR blend (the new-data test)
Now that 1h candles are available, we tested whether intraday mean reversion
([`intraday.py`](research/intraday.py)) supplies the *uncorrelated, chop-year*
return stream the trend book lacks. Walk-forward OOS, 1h bars, **6 bps/turn +
funding**:

| Coin (best MR engine) | OOS daily CAGR | 2022 | 2023 | 2024 | 2025 |
| --- | ---: | ---: | ---: | ---: | ---: |
| SOL (mr_z) | −43% | −98% | **+266%** | +129% | −86% |
| ETH (rsi_mr) | −64% | −69% | −6% | −19% | −91% |
| BTC (rsi_mr) | −23% | −69% | −0% | −24% | −18% |
| DOGE (rsi_mr) | −22% | **+67%** | **+60%** | −37% | **+56%** |
| XRP (rsi_mr) | −12% | −56% | **+150%** | −1% | +16% |
| **MR book (EW)** | — | −61% | **+90%** | +12% | −45% |

- **Diversification is real:** trend-book vs MR-book daily-return correlation =
  **+0.07** (essentially uncorrelated), and MR is strongly positive in 2023 (the
  prime trendless year).
- **But the edge does not survive costs:** every coin's intraday-MR sleeve is
  net-negative; at 6 bps/turn the high turnover eats the gross signal.
- **Blending does not raise the ceiling** ([`combine.py`](research/combine.py)),
  it only moves the misses around:

| Book = EW coins of (1−w)·trend + w·MR | best m | Banked ≥50% | which years miss |
| --- | :--: | :--: | --- |
| trend-only (w=0) | 3× | **8/10** | 2022, 2023 |
| trend + 20% MR | 3× | 7/10 | 2022, 2023, 2025 |
| trend + 35% MR | 3× | 7/10 | 2022, 2025 *(2023 rescued: +55%)* |
| trend + 50% MR | 5× | **8/10** | 2022, 2025 *(2023 rescued: +54%)* |

No blend weight or leverage (1–50× swept) exceeds **8/10 years ≥ +50%**.

### 12.8 — Cross-sectional momentum + blend ⭐ raises the ceiling to 90%
The 5-coin panel allows a structurally different return source: **cross-sectional
(relative-value) momentum** ([`xsection.py`](research/xsection.py)) — each day rank
the coins by trailing blended return and rotate into the strongest (long-only top-k,
or long top / short bottom), vol-targeted, walk-forward OOS. This earns in years
with *dispersion* even when the market is flat in aggregate.

| Sleeve (book, +50% lock) | best m | Banked ≥50% | Missed years |
| --- | :--: | :--: | --- |
| Absolute trend (TS-mom) | 3× | 8/10 (80%) | **2023, 2025** |
| **Cross-sectional (XS-mom)** | 2× | 8/10 (80%) | **2016, 2022** |
| Regime orchestrator (long/short) | 2× | 8/10 (80%) | 2023, 2025 *(banks 2022 +69%)* |

The win-sets are **complementary**: XS banks exactly the trendless years
(2023 +54%, 2025 +55%) that absolute trend misses. Blending the daily OOS streams
([`xs_blend.py`](research/xs_blend.py)) under the +50% lock:

| Blend (1−w)·trend + w·XS | best m | Banked ≥50% | Missed |
| --- | :--: | :--: | --- |
| trend-only | 3× | 8/10 | 2022, 2023 |
| **trend 70 / XS 30** | 3× | **9/10 (90%)** | **2022 only** |
| **trend 30 / XS 70** | 2× | **9/10 (90%)** | **2022 only** |

→ **9/10 (90%)** is robust across a wide weight band (not knife-edge). The lone
miss is **2022** (LUNA/3AC/FTX crash).

### 12.9 — Why 100% is not reachable with a static blend (dense proof)
Adding the orchestrator as a short-capable third sleeve
([`defensive_blend.py`](research/defensive_blend.py)) does **not** reach 10/10. A
**dense simplex search** over all (trend, XS, orch) weights (step 0.1) × leverage
{1,2,3,5} returns a **maximum of 9/10** — *zero* configurations bank all ten years.
The reason is structural, not a search failure:

- **2022** is banked only by the orchestrator (it shorts the bear: +61–69%), which
  is +0.80 correlated with trend and **loses 2023**.
- **2023 & 2025** are banked only by cross-sectional momentum, which **loses 2022**.
- The rescuing sleeves are **mutually exclusive in the contested years**, so any
  static averaging dilutes one of them below the +50% lock. You can choose *which*
  year to forgo (XS-heavy ⇒ miss 2022; orch-heavy ⇒ miss 2023), never neither.

**Dynamic switching does not help either** ([`regime_switch.py`](research/regime_switch.py)).
A causal risk-on/risk-off overlay — when an equal-weight market index confirms a
DOWN regime (below SMA_n *and* negative trailing momentum) route to the short-capable
orchestrator, else to the trend+XS up-engine — was swept over 24 (SMA window ×
momentum lookback) settings. **Zero reach 10/10; the maximum is 9/10**, the same
ceiling. The causal regime label cannot distinguish a *bear to short* (2022) from a
*recovery chop to rotate through* (2023) early enough — threading that needle needs
foresight, which is look-ahead. So the 2022/2023 tension is fundamental to the
information set, not an artifact of static averaging. **There is no causal strategy
on this universe that banks +50% — or is even positive — in all ten years.**

A fourth, independent confirmation ([`ls_trend_test.py`](research/ls_trend_test.py)):
the cleanest short-capable engine — a **pure long/short slow-trend CTA** (short below
a slow EMA, long above) — banks 2022 (+50…+63%) in nearly every parameter setting by
shorting the bear, but **misses 2023 (−40…−45%) in every setting**, because 2023 was
chop-with-net-up that whipsaws directional trend (its +50% is reachable only via the
cross-sectional dispersion sleeve). **No setting banks both 2022 and 2023** — the
required postures (sustained-short vs rotate-long) are opposite. The 2022 ⊻ 2023
trade-off is therefore confirmed by four independent constructions (dense simplex
blend, 3-sleeve defensive blend, causal regime switch, long/short CTA).

### 12.10 — Crash-hedge overlay (expand-scope route) ⟶ real bear-alpha, still not a guarantee
The only honest way past the all-long ceiling is to *add an instrument that profits
in a broad crash without bleeding otherwise* — a **trend-following short-basket
hedge** ([`crash_hedge.py`](research/crash_hedge.py)): short the equal-weight basket
when it is below a slow SMA *and* a fast EMA is falling (nimble exit), flat otherwise.

- **It generalises (not a 2022 fit).** Standalone the hedge profits in *both* bear
  markets — **2018 +72%, 2022 +70%** — and is negative/flat in up years.
- **Blended in, it does bank 2022** (e.g. +58%) while the XS sleeve still carries
  2023 (+69%), because the hedge is *additive* (short-only, mostly flat), not a
  reallocation — this is what the momentum-only sleeves could not do.
- **But it is NOT a robust every-year fix.** Rigorous robustness over 72 settings:
  only **1/72** reaches 11/12 years and it needs **5× leverage** (overfit, knife-edge);
  at sane leverage (m ≤ 3) the best is **9/12**, because the hedge's drag during
  *bull-market corrections* (false shorts: 2021 −19%, 2024 −25% standalone) cancels
  its crash gains. **No setting reaches 12/12.**

**Verdict on the hedge.** Its honest, deployable value is **drawdown reduction /
softer bear years** (a tail hedge), not a guaranteed +50% in the bear. Even this
expand-scope route lands back at the ~90% robust ceiling; the every-year-+50% claim
remains reachable only via overfitting (high-leverage knife-edge configs that lose
money live).

### 12.11 — Market-neutral stat-arb: why 2022 is structurally unbankable
The last untested posture — one that is neither net-long nor net-short — is a
**dollar-neutral cross-sectional long/short** ([`market_neutral.py`](research/market_neutral.py)):
equal long and short legs, indifferent to market direction, earning from *dispersion*
among the five coins. In principle this could be positive in a crash (short the
fastest-falling, e.g. SOL −94% in 2022, long the most resilient, e.g. BTC −64%).

- **It IS positive in 2022 (+13% raw)** — the dispersion mechanism is real — and
  strongly positive in 2018 (+148%); the directional sleeves cannot claim that.
- **But +13% ≪ +50%.** In a correlated crash the cross-sectional dispersion is too
  compressed to bank +50% without dangerous leverage; standalone it banks only 6/10
  years, and blended with the up-engine the book stays **9/10 (2022 = −41%)**.

This closes the posture space. The 2022 +50% miss is now explained from all sides:
**net-long loses the crash, net-short loses the 2023 recovery, and market-neutral
can extract only ~13% from the limited dispersion.** Seven independent constructions
(trend, cross-sectional long, intraday MR, long/short CTA, regime switch, crash
hedge, market-neutral stat-arb) agree: **+50% in 2022 — hence in *every* year — is
unreachable on this universe with causal information.** The honest, fully-OOS
ceiling is ~86–90% of years.

### 12.12 — Reaching for +1000%/yr: backtest artifact vs deployable reality
A leverage sweep on the OOS streams ([`target_1000.py`](research/target_1000.py),
annual-reset model with intraday-liquidation check) answers "is +1000%/yr reachable?"
The answer splits sharply between the **mean** and the **median (typical year)**:

| TREND+XS book, m | mean/yr | median/yr | worst yr | ruin yrs | compounded (no withdrawal) |
| ---: | ---: | ---: | ---: | :--: | ---: |
| 1× | +238% | +97% | −53% | 0/10 | 516× |
| 2× | **+2263%** | +218% | −81% | 0/10 | ~3.2e4× |
| 3× | **+16208%** | +322% | −93% | 0/10 | ~2.4e5× |
| 5× | +280466% | +312% | **−100%** | 1/10 | 0 (ruined) |
| 8× | +699939% | −52% | −100% | 2/10 | 0 (ruined) |
| ≥12× | −100% | −100% | −100% | ≥9/10 | 0 (ruined) |

- **As a backtest MEAN, +1000%/yr is "reached" at ≥2×** — but it is driven by a few
  gigantic years (best single year +20431% at 2×); the **median/typical year is only
  ~200–320%**. So it is not "1000% every year," it is "a couple of explosive years
  drag the average up."
- **Forcing the *median* to +1000% requires ≥8× leverage, which produces −100% ruin
  years** and zeroes compounded wealth. Classic gambler's ruin.

**These numbers are NOT a deployable expectation — they are a backtest artifact.**
Three reasons, all disqualifying on their own:
1. **Capacity/slippage.** A 2× compounded multiple of ~3.2e4 turns $100k into ~$3.2B
   in ten years; at that size your own orders move the market and the 6 bps cost
   assumption collapses. The strategy has finite capacity; these returns assume none.
2. **Regime dependence.** The mean leans on the once-off explosive 2016–2017 / 2021
   alt runs (DOGE/SOL up thousands of %); that magnitude is unlikely to repeat.
3. **Intraday-gap blindness.** Daily bars miss the −50% intraday flash crashes that
   *did* occur (Mar-2020, May-2021); at 2–3× effective those gaps are liquidations
   the daily model scores as survivable −80/−90% years.

**Verdict.** +1000%/yr exists only as a frictionless, capacity-free, regime-lucky
backtest **average**; the typical year is ~200–320% even before realistic haircuts,
and the leverage needed to make *every* year +1000% guarantees ruin. The honest,
realistically-deployable expectation remains the risk-controlled figures of §12–§13
(~50–90% of years banking +50%, ~33–50% CAGR), not four-digit annual returns.

### 12.13 — Mid/low-cap long-"sniping" (cross-sectional momentum on small alts)
Tested whether rotating long into the strongest mid/low-cap alts reaches the high
targets the large caps cannot ([`lowcap.py`](research/lowcap.py)). Basket = 20
mid/low caps via Binance Vision, deliberately including **crashed** (FTT, LUNA, GALA,
ROSE, AXS down 90–99%) and **delisted** (MATIC, FTM, WAVES) names to blunt
survivorship bias. Strategy: causal cross-sectional momentum, long top-k, rotating,
delisting-aware exit; walk-forward OOS. Per-year (m=1):

> 2021 **+1328%** · 2022 −40% · 2023 −40% · 2024 −40% · 2025 −42%

The entire return is the **single 2021 alt-mania**; every other OOS year bled to the
−40% stop (rotating into low-cap strength = chasing pumps that violently reverse).
Cost sensitivity is fatal:

| cost | OOS CAGR | Sharpe |
| --- | ---: | ---: |
| naive 6 bps (large-cap assumption) | +22% | 0.63 |
| **realistic 50 bps + delist gaps** | **−43%** | −0.29 |
| harsh 100 bps + delist gaps | **−61%** | −0.65 |

- **Net loser after realistic low-cap slippage** (−43% to −61% CAGR); the +22% at
  6 bps is fiction — low-cap books can't fill at large-cap costs.
- **The high leveraged "mean" is 100% the 2021 outlier**: at 2× the mean year is
  +1980% but the **median is −40%** — the typical year loses, one year won a lottery.
- **Still survivorship-biased upward** (coins that died before/without a Binance
  listing are absent), so live results would be worse than even this.

**Verdict.** Low-cap long-sniping is the *opposite* of consistent: one unrepeatable
alt-season carries it, it bleeds −40% otherwise, and it turns net-negative under
honest costs. It cannot be leveraged to +1000% sustainably (median year is a loss)
and it worsens the every-year-+50% problem rather than solving it. This is the
canonical frictionless/survivorship backtest illusion, now measured and rejected.

**Honesty caveat on the 90%.** Each sleeve is fully walk-forward OOS (params chosen
on train slices only). The *blend weight and leverage* for the 90% headline are
chosen by inspecting the OOS-period hit-rate — a mild meta-level in-sample choice.

**Allocation walk-forward (the last gap, now closed).**
[`alloc_wf.py`](research/alloc_wf.py) removes that hindsight: an expanding-window
walk-forward that picks (weight, leverage) using **only prior years** and applies
it to the next **unseen** year. Result — **6/7 testable years bank +50% (86%)**,
the allocation converging on w≈0.4 / m=3, with **2022 the sole miss**:

> 2019 +123%✅ · 2020 +53%✅ · 2021 +62%✅ · **2022 −41%** · 2023 +83%✅ ·
> 2024 +52%✅ · 2025 +74%✅  → **6/7 (86%), fully out-of-sample, no hindsight.**

So the genuine, hindsight-free figure is **~86%** (90% with the best static
allocation). Both agree on the structural miss (2022). This is the most rigorous
"OOS and walk-forward validated" number the study can produce.

---

## 13. Winner — precise spec

The strategy with the best, most robust year-on-year behaviour is the
**long-only multi-lookback momentum ensemble (`tsmom_blend`) with
inverse-vol position sizing**, deployed per-coin and combined into a
**BTC+ETH+DOGE equal-weight book** with an **annual +50% profit-lock**.

### 13.1 Signal (daily, causal)
```
For lookbacks L in lbs:                      # BTC/ETH: [10,30,60,120]; DOGE: [20,40,80,120]
    s_L[t] = sign( P[t] / P[t-L] - 1 )
raw[t]   = mean_L s_L[t]                      # ∈ [-1, +1]
```

### 13.2 Sizing (inverse-vol target, long-only)
```
rv[t]    = max( std(ret, 20) * sqrt(365), 0.10 )
w[t]     = clip( max(raw[t], 0) * min(vol_target / rv[t], max_lev), 0, max_lev )
```
- 30% (spot/low-lev) deployment: `vol_target=0.20–0.45`, `max_lev=3`.
- 50% (futures) deployment: `vol_target=0.60`, `max_lev=10` (effective leverage
  averages ~0.6–1.5×, spiking higher only in calm regimes).

### 13.3 Execution accounting
```
held[t] = w[t-1];  P&L per §4;  costs 6 bps/side + 1 bp/day funding.
```

### 13.4 Annual wrapper (the $100k / profit-withdrawal model)
```
each Jan 1: equity := $100,000
daily: equity *= (1 + m * strategy_return)        # m = book leverage (=3 for the book)
       if equity-100k  >= +50% of 100k:  FLAT for rest of year, withdraw +$50k+
       if equity-100k  <= -40% of 100k:  FLAT for rest of year (stop)
Dec 31: withdraw profit, reset to $100,000
```

### 13.5 Recommended deployable configuration (per coin)
| Coin | Engine | Params | Lev `m` |
| --- | --- | --- | :--: |
| BTC | tsmom_blend long-only | `lbs=[10,30,60,120], vol_target=0.6, vol_lb=20, max_lev=10` | 2–3× |
| ETH | tsmom_blend long-only | `lbs=[10,30,60,120], vol_target=0.6, vol_lb=20, max_lev=10` | 3× |
| DOGE | tsmom_blend long-only | `lbs=[20,40,80,120], vol_target=0.6, vol_lb=20, max_lev=10` | 2× |
| XRP | (no robust fit) | best `tsmom_blend`/`donchian`; **run tiny or exclude** | 1× |

**Why this is the "year-on-year" engine:** momentum is long the asset only while
it is trending up and **flat otherwise**, so it harvests the big up-years and sits
out the bears (BTC ≈flat in 2022 vs −65% buy-and-hold). The +50% profit-lock turns
"touched +50% intra-year" into a banked +50%; diversifying across BTC+ETH+DOGE
means *something* usually trends, lifting the book to **8/10 years ≥ +50%**.

### 13.6 Best-consistency configuration (2026-05-25) — trend + cross-sectional blend
The single most consistent validated configuration is the **two-sleeve momentum
blend** over the SOL/ETH/BTC/DOGE/XRP panel:

```
Sleeve A — absolute trend (per coin, then equal-weight book):
   tsmom_blend long-only + inverse-vol sizing (the §13.1–13.4 engine),
   BTC leg may use the regime orchestrator. Walk-forward OOS.
Sleeve B — cross-sectional momentum (xsection.py):
   each day rank the 5 coins by blended trailing return; hold top-k
   (k=1–2), optionally short bottom-k; vol-target the basket; walk-forward OOS.
Book return:  r[t] = w_A * A[t] + w_B * B[t]          # static, w_B ≈ 0.3–0.7
Annual wrapper: $100k reset each Jan; m ≈ 2–3×; +50% profit-lock / −40% stop.
```
Result: **9/10 calendar years ≥ +50% (90%)** out-of-sample, worst non-banked year
≈ −42% (2022), robust across the weight band. Sleeve B is what banks the trendless
2023 & 2025; Sleeve A carries the trend years. This supersedes the trend-only book
(8/10) as the recommended target — subject to the §12.9 honesty caveat that the
*allocation* weights should themselves be walk-forwarded at the deployment gate
(done in §12.9: fully-OOS allocation-walk-forward = **6/7, 86%**).

### 13.7 Deployable module — live target weights
[`production_strategy.py`](research/production_strategy.py) operationalises the
above into **today's target weights** from live daily data (Binance Vision/KuCoin):
- Sleeve A: `sig_tsmom_blend` long-only per coin (lbs per §13.5), vol-target 0.60,
  vol_lb 20, max_lev 3.
- Sleeve B: cross-sectional top-2 rotation, basket vol-targeted.
- Book = `0.60·A + 0.40·B` (the allocation the walk-forward converged on), with a
  **book gross-exposure cap of 2×** and the annual +50% lock / −40% stop wrapper.

Example output (2026-05-24): hold **ETH 39% + DOGE 39%**, gross 78% — the two
strongest-momentum coins; SOL/BTC/XRP not in qualifying uptrends ⇒ 0. This module
maps directly onto the production bot's risk/execution layer (§15).

---

## 14. Verdict on the 50%/yr objective

| Question | Honest answer |
| --- | --- |
| +50% in **every** calendar year, OOS? | **No.** Provably not reachable with a static blend of honest sleeves (§12.9); only via overfitting to the one holdout year. |
| Best achievable consistency? | **9/10 years (90%)** — trend+cross-sectional momentum blend, robust across weights (§12.8). Up from 8/10 (80%) for trend alone. |
| Best single-coin? | ETH 7/8 (88%), DOGE 7/9 (78%), SOL 3/4 (75%, real data), BTC 7/10 (70%). |
| The lone remaining miss? | **2022** (LUNA/3AC/FTX crash). Banked only by a short sleeve that then loses 2023; the rescuing sleeves are mutually exclusive in the contested years. |
| Did **real SOL** change it? | The real-SOL universe matches the DOT-proxy 80% band per-coin; the lift to 90% came from the cross-sectional sleeve the 5-coin panel enables. |
| Did **intraday** change it? | No — intraday MR is uncorrelated (corr +0.07) and helps 2023, but is net-negative after costs and only reshuffles misses; it does not raise the ceiling. |
| Does leverage help? | It raises good-year returns **and** ruin probability; beyond ~3× it **hurts** consistency (−100% liquidation years). Modest 2–3× + stop is the sane choice. |
| What *is* consistent? | The 30% diversified book: +33.6% CAGR, Sharpe 1.72, **positive 10/13 years**. |

A strategy that truly guaranteed +50% every year would be a risk-free arbitrage
the market would erase; "guaranteed consistent high returns with no down years" is
the signature of fraud, not an edge.

---

## 15. Deployment

1. **Data:** when intraday is wanted, allowlist `api.kucoin.com` (or run outside
   the sandbox) and run `kucoin_loader.py` → 1H/8H candles in `research/data/intraday/`.
2. **Validation gate:** re-run `run_v2.py` / `annual_target.py`; require the book
   to clear the agreed hit-rate before any capital.
3. **Live engine:** the production bot (`packages/bot`) already has Binance
   execution adapters, a scheduler, circuit breakers and a paper mode; the daily
   `tsmom_blend` weights + profit-lock map onto its risk/execution layer.
4. **Risk caps:** effective leverage ≤ 3×, per-year −40% stop, profit withdrawn at
   year end, paper-trade first.

---

## 16. Limitations & caveats

- **Daily bars drive the validated trend study** — intraday (1h) is now available
  and was used for the mean-reversion study (§12.7), but the trend backbone is
  daily; no tick-level stops/fills are modelled. Costs kept conservative.
- **Intraday MR is cost-bound** — the 1h mean-reversion edge is gross-positive in
  parts but net-negative at realistic 6 bps/turn; it is not a deployable standalone
  sleeve here, only a (weak, uncorrelated) diversifier.
- **Trend-following is lumpy** — per-coin returns concentrate in trend years;
  consistency is a *portfolio* property.
- **Leverage = ruin risk** — naive 10–50× produces −100% years; only vol-targeted,
  stop-protected, modest leverage is sane.
- **Past performance is not predictive**; walk-forward limits but does not remove
  regime-change risk. Paper-trade first.
- **XRP/LTC/DOT** do not support the 50% target on daily data; **SOL** (real) sits
  in the 75% band per-coin, 80% inside a book.

---

## 17. Files & reproduction

**Code:** [`data.py`](research/data.py) · [`engine.py`](research/engine.py) ·
[`strategies.py`](research/strategies.py) · [`walkforward.py`](research/walkforward.py) ·
[`run_research.py`](research/run_research.py) · [`robustness.py`](research/robustness.py) ·
[`portfolio_analysis.py`](research/portfolio_analysis.py) · [`run_v2.py`](research/run_v2.py) ·
[`annual_target.py`](research/annual_target.py) · [`binance_vision.py`](research/binance_vision.py) ·
[`kucoin_loader.py`](research/kucoin_loader.py) · [`intraday.py`](research/intraday.py) ·
[`combine.py`](research/combine.py) · [`xsection.py`](research/xsection.py) ·
[`xs_blend.py`](research/xs_blend.py) · [`defensive_blend.py`](research/defensive_blend.py) ·
[`regime_switch.py`](research/regime_switch.py) · [`ls_trend_test.py`](research/ls_trend_test.py) ·
[`crash_hedge.py`](research/crash_hedge.py) · [`alloc_wf.py`](research/alloc_wf.py) ·
[`production_strategy.py`](research/production_strategy.py) · [`market_neutral.py`](research/market_neutral.py) ·
[`target_1000.py`](research/target_1000.py) · [`lowcap.py`](research/lowcap.py)

**Results:** [`research_results.json`](research/results/research_results.json) ·
[`strategy_configs.json`](research/results/strategy_configs.json) ·
[`v2_results.json`](research/results/v2_results.json) ·
[`annual_target_results.json`](research/results/annual_target_results.json) ·
OOS equity CSVs in `research/results/`.

**Companion reports:** [`STRATEGY_FINDINGS.md`](STRATEGY_FINDINGS.md) (30% study) ·
[`STRATEGY_FINDINGS_V2.md`](STRATEGY_FINDINGS_V2.md) (50% study).

```bash
python3 -m venv research_venv && research_venv/bin/pip install numpy pandas
cd research
../research_venv/bin/python data.py                          # CM daily for the long-history coins
../research_venv/bin/python binance_vision.py SOL --daily     # real SOL daily (Binance mirror)
../research_venv/bin/python binance_vision.py --intraday 1h    # 1h candles, all 5 coins
../research_venv/bin/python run_research.py --all             # 30% study
../research_venv/bin/python run_v2.py                         # 50% leverage/orchestrator
../research_venv/bin/python annual_target.py                  # profit-lock + books (SOL ETH BTC DOGE XRP)
../research_venv/bin/python intraday.py                       # intraday mean-reversion sleeve
../research_venv/bin/python combine.py                        # trend + intraday-MR blend test
../research_venv/bin/python xsection.py                       # cross-sectional momentum sleeve
../research_venv/bin/python xs_blend.py                       # trend + XS blend -> 9/10 years (90%)
../research_venv/bin/python defensive_blend.py                # 3-sleeve blend + simplex proof (ceiling 9/10)
```
