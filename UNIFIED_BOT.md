# Unified Bot — one orchestrator combining the best of all the research

**What this is.** A single capital-allocated **orchestrator** that runs the four edges
this repo's research actually validated, as one book with a **risk-profile dial**, and
proves the *combination* is better than any part alone — walk-forward, out-of-sample.

It is the synthesis of three research lines:
- **CORE** — the **daily momentum book** (`DEPLOYABLE_STRATEGY_BUILD.md`,
  `production_strategy.py`): long-only, vol-targeted trend + cross-sectional rotation
  over SOL/ETH/BTC/DOGE/XRP.
- **BTC1H / ETH8H** — the **intraday day-trade survivors** (`DAYTRADE_BTC_ETH_WINRATE.md`
  §4): the two cells that passed rigorous rolling walk-forward (ADX-gated pullbacks).
- **SPINE** — the **all-weather long/short trend book** (`ALL_WEATHER_SPINE.md`,
  `all_weather.py`): "crisis alpha" that *shorts* confirmed downtrends and **earns in
  bears** (+22% in 2022). This is the defensive sleeve.

Reference: [`research/unified_bot.py`](research/unified_bot.py) (the bot),
[`research/defensive_test.py`](research/defensive_test.py) (the spine allocation sweep
+ bear-window test). Results: `research/results/unified_bot_results.json`,
`research/results/unified_bot_equity.csv`.

---

## TL;DR

- **Four near-uncorrelated sleeves.** Daily-return correlations with the CORE are
  **+0.04 (BTC1H)**, **+0.08 (ETH8H)**, **+0.14 (SPINE)** — independent return sources.
  The spine's protection is concentrated in the *tails* (bears), which is how crisis
  alpha works, not as a constant hedge.
- **A risk-profile dial, not a single book.** Over the common 2021–2026 OOS window
  (m=1):

  | Profile | CAGR | Sharpe | maxDD | worst yr | Aug-2025 bear ($10k) |
  |---|---:|---:|---:|---:|---:|
  | CORE only | 65% | 1.04 | −68% | −47% | — |
  | **GROWTH** (no spine) | 61% | 1.15 | −47% | −26% | $6,805 (−32%) |
  | **ALL-WEATHER** (+30% spine) | 44% | **1.21** | **−32%** | **−2%** | **$8,798 (−12%)** |

- **Adding the intraday sleeves (GROWTH)** lifts Sharpe 1.04 → 1.15 and cuts drawdown
  −68% → −47% — they even *rescued 2024*, a year CORE-only stopped out on (−42% → the
  combined banked +50%).
- **Adding the defensive spine (ALL-WEATHER)** is the bigger upgrade for survival:
  best Sharpe (1.21) and Calmar (1.39), drawdown −32%, and it **turns the −26% worst
  year into −2%** and **cuts the recent bear loss from −32% to −12%** — for a real CAGR
  give-up (61% → 44%). All-weather means *lower and smoother*, not higher.
- **2022/synchronized-crash protection now exists.** The fully-OOS allocation
  walk-forward (weights chosen each year from prior data) banks **+50% in 4/4 OOS years
  at m=3**, leaning into the spine when the tape weakened.

---

## 1. Architecture — four sleeves, one book, a risk dial

```
 CORE (daily, long-only momentum)   production_strategy.book_weights()          ─┐
   trend(60%)+XS(40%), SOL/ETH/BTC/DOGE/XRP, vol-targeted, gross≤2×   r_core[d]   │
 BTC1H (intraday)  WF-OOS: long BTC 1H dips, close>SMA50 & ADX≥30, ±3%  r_btc1h[d]│  capital
 ETH8H (intraday)  WF-OOS: long ETH 8H dips, close>SMA50 & ADX≥20,      r_eth8h[d]│─ split w
                   TP 3×ATR/SL 1.5×ATR                                            │  (profile)
 SPINE (daily L/S) WF-OOS: long/short top-30 TS-trend, vol-weighted —   r_spine[d]│
                   SHORTS confirmed downtrends → crisis alpha (earns bears)       ─┘
                                          │
              combined[d] = Σ  w_sleeve · r_sleeve[d]   (GROWTH or ALL-WEATHER)
                                          ▼
              annual $100k wrapper (+50% lock / −40% stop, m× leverage)
```

Each sleeve produces a **daily net-return stream**: CORE and SPINE are dense (daily);
the intraday sleeves bucket each OOS trade's PnL to its exit date. The intraday and
spine sleeves choose their parameters **out-of-sample per fold** (rolling walk-forward,
train→unseen-test); the daily CORE is the fixed pre-validated config. Costs: 6 bps/side
on CORE & intraday, **15 bps/side on the spine** (top-30, less liquid — its validated
assumption). The orchestrator blends the streams by capital weight (the profile dial)
and applies the annual wrapper.

---

## 2. Validation (walk-forward OOS, 2021-05-30 → 2026-05-24, 1821 days)

### 2.1 Standalone sleeves (1×)
| sleeve | CAGR | ann vol | Sharpe | max DD | character |
|---|---:|---:|---:|---:|---|
| CORE | 65.3% | 75.4% | 1.04 | −67.8% | high-octane long-only trend engine |
| BTC1H | 10.9% | 17.4% | 0.68 | −24.3% | steady, low-vol intraday |
| ETH8H | 32.5% | 31.3% | 1.05 | −36.8% | punchy, fat-tailed intraday |
| SPINE | 6.3% | 40.7% | 0.35 | −43.9% | low standalone return — but **positive in bears** |

The spine looks weak standalone (it gives up bull upside to be able to short) — its
value is **diversification + crisis alpha**, visible only in the book, not alone.

### 2.2 Correlation matrix
|  | CORE | BTC1H | ETH8H | SPINE |
|---|---:|---:|---:|---:|
| **CORE** | 1.00 | 0.04 | 0.08 | 0.14 |
| **BTC1H** | 0.04 | 1.00 | −0.05 | 0.03 |
| **ETH8H** | 0.08 | −0.05 | 1.00 | 0.09 |
| **SPINE** | 0.14 | 0.03 | 0.09 | 1.00 |

### 2.3 Risk profiles (m=1) — the dial
| book | CAGR | ann vol | Sharpe | max DD | Calmar | worst yr |
|---|---:|---:|---:|---:|---:|---:|
| CORE only | 65.3% | 75.4% | 1.04 | −67.8% | 0.96 | −47.1% |
| **GROWTH** (no spine) | 60.7% | 53.5% | 1.15 | −46.7% | 1.30 | −26.2% |
| **ALL-WEATHER** (+30% spine) | 43.8% | 35.0% | **1.21** | **−31.6%** | **1.39** | **−1.8%** |

Each step adds diversification: the intraday sleeves (GROWTH) and then the defensive
spine (ALL-WEATHER) raise Sharpe and shrink drawdown. The all-weather book's worst
calendar year is essentially flat (−2%) vs −47% for the raw core.

### 2.4 Annual $100k wrapper — % of full years banking +50% (4 overlap years)
| book | m=2 | m=3 |
|---|---:|---:|
| GROWTH | 3/4 | 2/4 |
| ALL-WEATHER | **3/4** (worst yr −8%) | **3/4** (worst −19%) |
| alloc walk-forward (OOS weights) | 3/4 | **4/4** |

The fully-OOS allocation walk-forward chose **40/20/20/20** most years and **leaned to
45% spine into 2023**; at m=3 it banked **+50% every full OOS year (4/4)**. *(Thin
sample — 4 full years overlap the intraday/spine OOS; read §2.3 Sharpe/maxDD/worst-year
as the robust claim and this as supporting.)*

### 2.5 Bear-market stress — $10k from 2025-08-01 (a real all-coin bear: BTC −32%, ETH −39%, alts −48% to −54%)
| profile (CORE/B1H/E8H/SPINE) | final $ | return | max DD |
|---|---:|---:|---:|
| GROWTH (70/15/15/0) | $6,805 | −31.9% | −46% |
| +15% spine (55/15/15/15) | $7,783 | −22.2% | −35% |
| **ALL-WEATHER (40/15/15/30)** | **$8,798** | **−12.0%** | −24% |
| spine-led (25/15/15/45) | $9,832 | −1.7% | −18% |
| all-weather-max (15/12/12/60) | $10,514 | +5.1% | −16% |

The defensive spine monotonically protects the bear: at 30% it cuts the loss by
two-thirds; at ≥45% the book is roughly breakeven-to-positive *through a −40% market*.
Reproduce: [`research/defensive_test.py`](research/defensive_test.py).

---

## 3. Deployable configuration

| Sleeve | GROWTH | ALL-WEATHER | Exact rule |
|---|---:|---:|---|
| **CORE** | 70% | 40% | Daily 0.60·trend + 0.40·cross-sectional, SOL/ETH/BTC/DOGE/XRP, long-only, vol-targeted, gross ≤ 2× (`DEPLOYABLE_STRATEGY_BUILD.md`). |
| **BTC1H** | 15% | 15% | Long BTC 1H when `close>SMA50` & `ADX(14)≥30` & `RSI(7)≤35`; ±3% bracket, 48h stop. |
| **ETH8H** | 15% | 15% | Long ETH 8H when `close>SMA50` & `ADX(14)≥20` & `RSI(7)≤45`; TP 3×ATR / SL 1.5×ATR, 12-bar stop. |
| **SPINE** | 0% | **30%** | Long/short top-30 by own multi-lookback TS-trend, inverse-vol weighted, gross-targeted (`ALL_WEATHER_SPINE.md`). |

**Pick by objective:** GROWTH for max bull-harvest (you accept −47% drawdowns and a
bad bear); **ALL-WEATHER (default)** for the best risk-adjusted, drawdown-aware book
(give up ~CAGR, get a −2% worst year and bear protection). Account: $100k annual reset,
**+50% lock / −40% stop**, whole-book leverage **m = 2–3** (the −40% stop is mandatory).

A live run today (all-weather profile) targets: **CORE 40% → ETH 39% / DOGE 39%**
(the qualifying uptrends); **BTC1H/ETH8H 15%** each armed on their dip triggers;
**SPINE 30%** long/short the top-30 trend (currently short-leaning into the weak tape).

---

## 4. Honest caveats
- **All-weather costs upside.** +30% spine drops CAGR ~61% → ~44%. There is no free
  lunch: the spine buys bear protection and a −2% worst year by giving up bull harvest.
  If you are sure you can time regimes, run GROWTH; if not, ALL-WEATHER survives more.
- **The spine is cost-sensitive** (15 bps fine, degrades by 30 bps, gone at 50 bps —
  top-30 liquidity, modest size only). The intraday sleeves and CORE are 6 bps.
- **2022/synchronized-crash is softened, not free.** The spine *earns* in orderly
  bears by shorting; a violent gap-crash can still hurt. The −40% annual stop remains
  mandatory.
- **Annual %-banking rests on 4 overlap years** (intraday/spine OOS starts 2021); it is
  noisy. The 1821-day Sharpe/Calmar/maxDD/worst-year (§2.3) is the trustworthy claim.
- **ETH8H is high-variance**; **intraday PnL is bucketed to exit-day** (a modeling
  simplification). Leverage applies to the whole book — consider levering only the
  daily core in live trading. Past performance is not predictive; paper-trade first.

## 5. Reproduce
```bash
cd research
python3 unified_bot.py        # 4-sleeve orchestrator: sleeves, correlations, profiles,
                              # annual wrapper, alloc-WF, live snapshot -> results JSON + equity
python3 defensive_test.py     # spine allocation sweep + the Aug-2025 $10k bear stress test
```
Depends on the cached daily panel (`research/data/`), BTC/ETH 1H OHLC
(`research/data/intraday/`), and the top-30 universe (`research/data/universe/`).
