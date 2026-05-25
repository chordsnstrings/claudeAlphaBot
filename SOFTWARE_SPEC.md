# Software Specification — Asset-Specific Crypto Trading System

**Project:** systematic crypto strategy discovery + walk-forward validation harness
(`research/`), built to find per-coin strategies for **BTC, ETH, XRP, DOGE** (plus
ADA, BNB, LINK, LTC, DOT as breadth) and validate them out-of-sample.
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
| **Source** | Coin Metrics *community* network data, pulled from `raw.githubusercontent.com/coinmetrics/data/master/csv/<asset>.csv`. |
| **Field** | Daily close = `PriceUSD` (legacy, full history for older assets) with `ReferenceRateUSD` fallback. |
| **Frequency** | **Daily** (1 bar/day, UTC). Intraday (1H/8H) is **unavailable** in this sandbox — every exchange/aggregator API (Binance, Coinbase, Kraken, **KuCoin**) returns HTTP 403 "Host not in allowlist"; a ready KuCoin loader (`kucoin_loader.py`) is included for when the host is reachable. |
| **Coverage** | BTC 2014‑01‑01→, ETH 2016‑06‑01→, XRP 2014‑08‑15→, DOGE 2015‑01‑01→, LTC 2013→, ADA/BNB/LINK 2017→, DOT 2020→. All to 2026‑05‑24. |
| **Cleaning** | drop null/≤0 prices, dedupe by date, sort ascending; cached as slim `date,close,volume_usd` CSVs in `research/data/`. |

**SOL note:** SOL price is not in the community tier (7-row stub); **DOT** is the
high-beta-L1 analog used in its place.

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
11. **Conclusion.** ~80% of years is the honest ceiling; +50% every year is not
    attainable OOS without overfitting (refused).

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

---

## 14. Verdict on the 50%/yr objective

| Question | Honest answer |
| --- | --- |
| +50% in **every** calendar year, OOS? | **No.** Not achievable without overfitting. |
| Best single-coin? | ETH 7/8 (88%), DOGE 7/9 (78%), BTC 7/10 (70%). |
| Best book? | BTC+ETH+DOGE 8/10 (80%), worst year −43%. |
| Why the misses? | 2023 & 2025 had no +50% directional move to lock. |
| Does leverage help? | It raises good-year returns **and** ruin probability; net it **hurts** consistency (XRP −112%). Modest 2–3× + stop is the sane choice. |
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

- **Daily bars only** — no intraday stops/fills; costs kept conservative; 1H/8H
  unavailable in-sandbox (KuCoin/all exchanges blocked).
- **Trend-following is lumpy** — per-coin returns concentrate in trend years;
  consistency is a *portfolio* property.
- **Leverage = ruin risk** — naive 10–50× produces −100% years; only vol-targeted,
  stop-protected, modest leverage is sane.
- **Past performance is not predictive**; walk-forward limits but does not remove
  regime-change risk. Paper-trade first.
- **XRP/LTC/DOT** do not support the 50% target on daily data.

---

## 17. Files & reproduction

**Code:** [`data.py`](research/data.py) · [`engine.py`](research/engine.py) ·
[`strategies.py`](research/strategies.py) · [`walkforward.py`](research/walkforward.py) ·
[`run_research.py`](research/run_research.py) · [`robustness.py`](research/robustness.py) ·
[`portfolio_analysis.py`](research/portfolio_analysis.py) · [`run_v2.py`](research/run_v2.py) ·
[`annual_target.py`](research/annual_target.py) · [`kucoin_loader.py`](research/kucoin_loader.py)

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
../research_venv/bin/python data.py
../research_venv/bin/python run_research.py --all      # 30% study
../research_venv/bin/python run_v2.py                  # 50% leverage/orchestrator
../research_venv/bin/python annual_target.py BTC ETH XRP DOGE   # profit-lock + books
```
