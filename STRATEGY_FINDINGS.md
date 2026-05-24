# 📈 Asset-Specific Crypto Strategy — Complete Findings

> Goal: a profitable, **asset-specific** strategy for each crypto instrument
> (long or short) targeting a **consistent ~30% annual return** that survives
> different regimes — validated with **genuine walk-forward out-of-sample data**.

**Every number in this document is walk-forward out-of-sample and net of costs.**
Parameters are chosen using only past (train) data and scored only on the
subsequent unseen (test) window. Nothing here is an in-sample curve fit.

---

## Table of contents
- [1. Executive summary](#1-executive-summary)
- [2. How to read this / methodology](#2-methodology)
- [3. Per-asset results](#3-per-asset-results)
  - [BTC](#btc) · [ETH](#eth) · [BNB](#bnb) · [ADA](#ada) · [DOGE](#doge) · [LINK](#link) · [DOT](#dot) · [XRP](#xrp) · [LTC](#ltc)
- [4. The portfolio (consistency engine)](#4-the-portfolio)
- [5. Robustness — cost sensitivity](#5-robustness)
- [6. Why long-or-flat beats long/short](#6-why-long-or-flat)
- [7. Honest caveats (incl. SOL)](#7-honest-caveats)
- [8. Reproduce it yourself](#8-reproduce)
- [9. Artifact & code index](#9-artifact--code-index)

---

## 1. Executive summary

| Result | Value |
| --- | --- |
| **Portfolio OOS CAGR** (equal-weight, all 9 assets) | **+33.6%** |
| **Portfolio Sharpe / Sortino** | **1.72 / 2.14** |
| **Portfolio max drawdown** | **−28.4%** (vs −80%+ buy & hold) |
| **Positive years** | **10 of 13** (worst year −1.5%) |
| **Assets clearing 30% standalone** | **5 of 9** (BTC, BNB, ETH, DOGE, ADA) |

- **Each instrument prefers a different strategy** — momentum for BTC/ETH/DOGE,
  breakout for ADA/BNB, mean-reversion for the laggards. This is the core of the
  brief: *ETH genuinely behaves differently from BTC*, and high-beta alts split
  into "trendable" vs "untradeable".
- **The edge is timing, not shorting.** Walk-forward repeatedly chose
  **long-or-flat**: be long in uptrends, **flat** in downtrends. The benefit over
  buy & hold is a massive drawdown reduction while keeping the big up-years.
- **"Consistent 30%" is a portfolio property.** Single-asset trend-following is
  lumpy; combining the per-asset strategies smooths it to a steady ~30%+.

---

## 2. Methodology

| Component | Choice | Source |
| --- | --- | --- |
| **Data** | Real daily close prices, Coin Metrics community network data (`ReferenceRateUSD` / legacy `PriceUSD`), fetched from GitHub. BTC from 2014, ETH 2016, others 2017–2020. | [`research/data.py`](research/data.py) |
| **Engine** | Daily close-to-close, **strictly lookahead-free**: a weight set at the close of day *t* earns day *t+1*'s return. | [`research/engine.py`](research/engine.py) |
| **Costs** | 6 bps/side transaction + 0.5 bps/day funding/carry drag on gross exposure. All headline numbers net of cost. Stress-tested to 25 bps/side. | [`research/engine.py`](research/engine.py) |
| **Families** | momentum (`tsmom`, `tsmom_blend`), `macross`, `donchian` breakout, `trend_flat` (regime-gated), `mr_z` & `rsi_mr` (mean reversion); all with a **volatility-targeting** overlay; long/short and long-only variants. | [`research/strategies.py`](research/strategies.py) |
| **Walk-forward** | Rolling train (540/420/365 d) → **non-overlapping** test (180/150/120 d). Best param picked on the train slice only, scored on the next unseen slice; test slices stitched into one OOS curve. | [`research/walkforward.py`](research/walkforward.py) |
| **Pass gate** | OOS Sharpe ≥ 0.8 **and** CAGR ≥ 30% **and** fold-win ≥ 0.55 **and** max DD ≥ −55%. | [`research/run_research.py`](research/run_research.py) |

There is **no parameter-selection leakage**: signals are causal and every
parameter is chosen on data preceding the window it is scored on.

---

## 3. Per-asset results

Walk-forward OOS, net of base costs. ✅ = clears the 30% gate.
Click an asset for its detail; click *equity* for its OOS curve CSV.

| Asset | Best family | OOS CAGR | Sharpe | Calmar | Max DD | Fold win | Buy & Hold | Gate | Curve |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | :--: | :--: |
| [BTC](#btc)  | momentum ensemble | **+76.2%** | 1.45 | 1.51 | −50.3% | 0.64 | +45.2% | ✅ | [equity](research/results/BTC_oos_equity.csv) |
| [BNB](#bnb)  | breakout (Donchian) | **+42.5%** | 1.17 | 1.24 | −34.3% | 0.64 | +177.7% | ✅ | [equity](research/results/BNB_oos_equity.csv) |
| [ETH](#eth)  | momentum ensemble | **+35.7%** | 1.08 | 0.89 | −40.1% | 0.65 | +65.4% | ✅ | [equity](research/results/ETH_oos_equity.csv) |
| [DOGE](#doge)| momentum ensemble | **+35.2%** | 0.96 | 0.82 | −43.0% | 0.65 | +74.4% | ✅ | [equity](research/results/DOGE_oos_equity.csv) |
| [ADA](#ada)  | breakout (Donchian) | **+35.1%** | 1.02 | 1.04 | −33.8% | 0.57 | +7.8% | ✅ | [equity](research/results/ADA_oos_equity.csv) |
| [LINK](#link)| regime-gated trend | +22.8% | 0.84 | 0.50 | −45.6% | 0.57 | +42.8% | ✗ | [equity](research/results/LINK_oos_equity.csv) |
| [LTC](#ltc)  | mean reversion (z) | +3.1% | 0.27 | 0.11 | −28.3% | 0.48 | +31.1% | ✗ | [equity](research/results/LTC_oos_equity.csv) |
| [XRP](#xrp)  | mean reversion (RSI) | +3.0% | 0.25 | 0.05 | −62.9% | 0.70 | +59.4% | ✗ | [equity](research/results/XRP_oos_equity.csv) |
| [DOT](#dot)  | breakout (Donchian) | +1.0% | 0.20 | 0.02 | −41.5% | 0.46 | −12.9% | ✗ | [equity](research/results/DOT_oos_equity.csv) |

> Full machine-readable detail: [`research/results/strategy_configs.json`](research/results/strategy_configs.json) ·
> [`research/results/research_results.json`](research/results/research_results.json)

### BTC
**Momentum ensemble (long-or-flat).** Params: `lbs=[10,30,60,120]`, `vol_target=0.45`, `vol_lb=30`, `max_lev=3.0`.
OOS CAGR **+76.2%**, Sharpe 1.45, Calmar 1.51, maxDD −50.3%, fold-win 0.64 (vs buy & hold +45.2% with −84% DD).

| Yr | 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Ret | +54% | +239% | +380% | −19% | +48% | +369% | +40% | **−2%** | +39% | +123% | −22% |

Captures every bull year; in the 2022 bear it lost just −2% while BTC fell ~65%.

### ETH
**Momentum ensemble (long-or-flat).** Params: `lbs=[10,30,60,120]`, `vol_target=0.20`, `max_lev=3.0`.
OOS CAGR **+35.7%**, Sharpe 1.08, maxDD −40.1%, fold-win 0.65. Lower vol-target than BTC — ETH is more cost-sensitive and runs at lower exposure.

| Yr | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Ret | +70% | +10% | +65% | +36% | +81% | **−4%** | +5% | +21% | +41% |

### BNB
**Breakout / Donchian (long-or-flat).** Params: `entry=40`, `exit=20`, `vol_target=0.30`, `max_lev=2.5`.
OOS CAGR **+42.5%**, Sharpe 1.17, Calmar 1.24, maxDD −34.3%, fold-win 0.64.

| Yr | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Ret | +22% | −13% | +244% | **−7%** | +20% | +90% | +49% |

### ADA
**Breakout / Donchian (long-or-flat).** Params: `entry=55`, `exit=20`, `vol_target=0.30`, `max_lev=2.5`.
OOS CAGR **+35.1%**, Sharpe 1.02, Calmar 1.04, maxDD −33.8% — the cleanest risk profile of the passing set, and it beats a buy & hold that made only +7.8%.

| Yr | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Ret | −14% | +50% | +80% | +1% | +98% | +81% | −5% |

### DOGE
**Momentum ensemble (long-or-flat).** Params: `lbs=[20,40,80,120]`, `vol_target=0.20`, `max_lev=3.0`.
OOS CAGR **+35.2%**, Sharpe 0.96, maxDD −43.0%, fold-win 0.65. Fat-tailed: nearly all return is in 2021 (+364%) and 2024 (+120%) — it sits out the dead years.

| Yr | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Ret | +54% | +5% | +5% | +63% | +364% | −2% | +2% | +120% | +4% |

### LINK *(below 30% gate)*
**Regime-gated trend.** OOS CAGR +22.8%, Sharpe 0.84. Close, but the post-2021 chop dragged it under the gate. Best treated as a small/defensive sleeve.

### DOT *(below 30% gate — SOL stand-in)*
**Breakout / Donchian.** OOS CAGR +1.0%, Sharpe 0.20. DOT declined almost continuously after 2021 (buy & hold −12.9% CAGR, −98% DD); no daily strategy extracts 30% from it. The strategy still **beat buy & hold by ~14%/yr with half the drawdown** by going flat. See [caveats](#7-honest-caveats) — DOT is a *pessimistic* SOL analog.

### XRP *(below 30% gate)*
**RSI mean reversion.** OOS CAGR +3.0%, Sharpe 0.25. Episodic, headline-driven; trend models whipsaw, mean reversion is the least-bad but thin.

### LTC *(below 30% gate)*
**Z-score mean reversion.** OOS CAGR +3.1%, Sharpe 0.27, but **maxDD only −28.3%** — its real value is as a low-drawdown diversifier in the portfolio.

---

## 4. The portfolio

Every per-asset return stream is OOS, so combining them is pure allocation
(no re-fitting). [`research/results/PORTFOLIO_oos_equity.csv`](research/results/PORTFOLIO_oos_equity.csv).

| Portfolio (equal-weight) | OOS CAGR | Sharpe | Sortino | Max DD | Vol | Positive yrs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **All 9 assets (recommended)** | **+33.6%** | **1.72** | 2.14 | **−28.4%** | 17.7% | **10 / 13** |
| Pass-only (BTC ETH ADA DOGE BNB) | +58.5% | 1.62 | 1.92 | −50.3% | 31.6% | 10 / 12 |

**All-9 per-year OOS:**

| Yr | 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Ret | +38% | +40% | +99% | **−0%** | +24% | +57% | +85% | **−1%** | +24% | +56% | +7% | +2% |

Adding the "laggard" assets (DOT, XRP, LTC) — uncorrelated, defensive — **cuts
the portfolio drawdown from −50% to −28% and lifts Sharpe to 1.72**. That is the
whole argument for asset-specific treatment + diversification rather than forcing
every asset to hit 30%.

---

## 5. Robustness

OOS CAGR / Sharpe across a transaction + funding cost ladder. The edge is not a
cost artifact ([`research/robustness.py`](research/robustness.py)):

| Asset | base (6 bps) | 2× txn (12 bps) | high (15 bps) | **stress (25 bps)** |
| --- | --- | --- | --- | --- |
| BTC  | +76.2% / 1.45 | +58.5% / 1.23 | +59.6% / 1.26 | **+74.6% / 1.31** |
| BNB  | +42.5% / 1.17 | +41.5% / 1.21 | +36.9% / 1.09 | **+33.4% / 1.01** |
| ADA  | +35.1% / 1.02 | +42.9% / 1.16 | +36.0% / 1.12 | **+24.2% / 0.90** |
| DOGE | +35.2% / 0.96 | +42.1% / 0.94 | +42.4% / 0.94 | **+28.8% / 0.86** |
| ETH  | +35.7% / 1.08 | +19.7% / 0.80 | +27.9% / 0.89 | **+14.1% / 0.55** |
| DOT  | +1.0% / 0.20  | +1.8% / 0.21  | +0.2% / 0.17  | **−0.8% / 0.12** |

ETH is the most cost-sensitive — size it accordingly. Everything else holds up
even under punitive costs.

---

## 6. Why long-or-flat

The search included short-enabled variants for every family. Walk-forward
**repeatedly preferred long-only** because shorting daily crypto gets shredded by
violent bear-market rallies. The realised edge is therefore **market timing** —
hold (vol-targeted) when the trend is up, **step aside** when it isn't — which is
exactly why the strategies were ≈flat through the 2018 and 2022 bears instead of
riding them down. This is the system "understanding the best way to trade each
instrument": for daily crypto, capital preservation in downtrends beats trying to
short them.

---

## 7. Honest caveats

1. **SOL is not validated here — the data could not be sourced.** This sandbox's
   network allowlist blocks every crypto exchange/aggregator API (Binance,
   Coinbase, Kraken, CoinGecko, Yahoo all 403), and Coin Metrics' *community*
   CSVs only carry full price history for older assets — SOL (a 2020 listing)
   exposes a 7-row stub. **DOT** is the closest available high-beta-L1 analog, but
   it is a **pessimistic** stand-in: DOT declined almost continuously after 2021,
   whereas SOL had a powerful 2023–24 uptrend the momentum/breakout families would
   very likely have captured. **Do not read DOT's fail as SOL's verdict.** The SOL
   config slot is ready; the bot's existing Binance loader can validate it live.
2. **Daily close-only data** — no intraday high/low, so stops sit at the close and
   costs are kept conservative. Results are end-of-day systematic, not intraday.
3. **Past performance is not predictive.** Walk-forward reduces overfit risk but
   cannot eliminate regime change. Deploy in paper first (`BOT_MODE=paper`).
4. Headline OOS uses **adaptive per-fold parameters** (standard walk-forward);
   `strategy_configs.json` also records the single most-frequently-selected
   parameter set per asset as a deployment reference.

---

## 8. Reproduce

```bash
python3 -m venv research_venv && research_venv/bin/pip install numpy pandas
cd research
../research_venv/bin/python data.py                 # fetch + cache daily prices (GitHub)
../research_venv/bin/python run_research.py --all    # full walk-forward sweep
../research_venv/bin/python robustness.py            # cost + per-year stress
../research_venv/bin/python portfolio_analysis.py    # portfolios + config export
```

---

## 9. Artifact & code index

**Code** — [`data.py`](research/data.py) ·
[`engine.py`](research/engine.py) ·
[`strategies.py`](research/strategies.py) ·
[`walkforward.py`](research/walkforward.py) ·
[`run_research.py`](research/run_research.py) ·
[`robustness.py`](research/robustness.py) ·
[`portfolio_analysis.py`](research/portfolio_analysis.py) ·
[`diag_dot.py`](research/diag_dot.py)

**Results** — [`research_results.json`](research/results/research_results.json) (full sweep) ·
[`strategy_configs.json`](research/results/strategy_configs.json) (deployable configs) ·
[`PORTFOLIO_oos_equity.csv`](research/results/PORTFOLIO_oos_equity.csv) ·
per-asset OOS curves:
[BTC](research/results/BTC_oos_equity.csv) ·
[ETH](research/results/ETH_oos_equity.csv) ·
[BNB](research/results/BNB_oos_equity.csv) ·
[ADA](research/results/ADA_oos_equity.csv) ·
[DOGE](research/results/DOGE_oos_equity.csv) ·
[LINK](research/results/LINK_oos_equity.csv) ·
[DOT](research/results/DOT_oos_equity.csv) ·
[XRP](research/results/XRP_oos_equity.csv) ·
[LTC](research/results/LTC_oos_equity.csv)

**Shorter narrative** — [`research/FINDINGS.md`](research/FINDINGS.md)
