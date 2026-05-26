# Unified Bot — one orchestrator combining the best of all the research

**What this is.** A single capital-allocated **orchestrator** that runs the three
edges this repo's research actually validated, as one book, and proves the
*combination* is better than any part alone — walk-forward, out-of-sample.

It is the synthesis of two research lines:
- the **daily momentum book** (`DEPLOYABLE_STRATEGY_BUILD.md`, `production_strategy.py`) —
  long-only, vol-targeted trend + cross-sectional rotation over SOL/ETH/BTC/DOGE/XRP;
- the **intraday day-trade study** (`DAYTRADE_BTC_ETH_WINRATE.md`) — the two cells that
  survived rigorous rolling walk-forward: **BTC 1H** and **ETH 8H** ADX-gated pullbacks.

Reference implementation: [`research/unified_bot.py`](research/unified_bot.py).
Results: [`research/results/unified_bot_results.json`](research/results/unified_bot_results.json),
equity curve `research/results/unified_bot_equity.csv`.

---

## TL;DR

- **The sleeves are nearly uncorrelated.** Daily-return correlation between the daily
  momentum CORE and each intraday sleeve is **+0.04 (BTC1H)** and **+0.08 (ETH8H)**;
  the two intraday sleeves are **−0.05** to each other. They are independent return
  sources, which is the whole point of combining them.
- **Combining improves risk-adjusted return and cuts drawdown.** At equal (1×)
  leverage over the common 2021–2026 OOS window, moving from CORE-only to the
  combined book lifts **Sharpe 1.04 → 1.15**, **Sortino 1.43 → 1.56**, **Calmar
  0.96 → 1.30**, and shrinks **max drawdown −67.8% → −46.7%** — for only a small CAGR
  give-up (65% → 61%). You buy a much smoother ride for a sliver of return.
- **The intraday sleeves rescued a year the core missed.** Under the annual $100k
  wrapper, CORE-only *missed* 2024 (−42%, an intra-year stop-out); the combined book
  (OOS-chosen allocation) **banked +50% in 2024 (+87%)**. The lone shared miss is
  **2022** — a synchronized all-coin crash that no long-biased book escapes (the same
  documented structural failure mode as the daily study).
- **The honest allocation walk-forward wants *more* intraday, not less.** Re-choosing
  weights each year from prior data only, it picked **60% CORE / 20% BTC1H / 20% ETH8H**
  every year and banked **+50% in 3/4 full OOS years (75%)**.

---

## 1. Architecture — three sleeves, one book

```
            ┌─────────────────────────── CORE (daily) ───────────────────────────┐
 daily 5-   │ production_strategy.book_weights():                                 │
 coin panel │  trend(60%) tsmom_blend  +  cross-sectional(40%) top-2 rotation     │ ── r_core[d]
 (binance   │  long-only, inverse-vol, gross≤2×   (the pre-validated deployable)  │   (daily net)
  vision)   └─────────────────────────────────────────────────────────────────────┘
            ┌─────────────────────────── BTC1H (intraday) ───────────────────────┐
 BTC 1h     │ rolling walk-forward (params OOS per fold): long BTC on 1H dips      │ ── r_btc1h[d]
 OHLC       │  when close>SMA50 & ADX(14)≥30; ±3% bracket, 48h stop               │  (trade PnL → exit-day)
            └─────────────────────────────────────────────────────────────────────┘
            ┌─────────────────────────── ETH8H (intraday) ───────────────────────┐
 ETH 8h     │ rolling walk-forward (params OOS per fold): long ETH on 8H dips      │ ── r_eth8h[d]
 OHLC       │  when close>SMA50 & ADX(14)≥20; TP 3×ATR / SL 1.5×ATR, 12-bar stop   │  (trade PnL → exit-day)
            └─────────────────────────────────────────────────────────────────────┘
                                          │
                    capital allocation  w·r   (fixed robust OR OOS walk-forward)
                                          ▼
                 combined[d] = w_core·r_core + w_btc·r_btc1h + w_eth·r_eth8h
                                          ▼
                 annual $100k wrapper (+50% lock / −40% stop, m× leverage)
```

**Daily accounting (no look-ahead).** The CORE book's daily net return is
`Σ_coin held·ret − txn·turnover − funding·gross` (held = yesterday's weight). Each
intraday sleeve is run through its own rolling walk-forward (train 365d → unseen
120d, params chosen on train by expectancy); each OOS **trade's net return is bucketed
to its exit date**, giving a sparse daily return stream for a 1× sleeve. The three
daily streams are aligned on the daily calendar (intraday sleeves = 0 on no-trade
days) and blended by capital weight. Costs: 6 bps/side + funding everywhere.

**Provenance of each sleeve's validation:** CORE — `DEPLOYABLE_STRATEGY_BUILD.md` §1
(9/10 yrs +50% OOS); BTC1H / ETH8H — `DAYTRADE_BTC_ETH_WINRATE.md` §4 (rolling WF,
fold/trade-concentration probed). Here the **combination** is what we validate.

---

## 2. Validation (walk-forward OOS, common window 2021-05-30 → 2026-05-24, 1821 days)

### 2.1 Standalone sleeves (1×, over the common window)
| sleeve | CAGR | ann vol | Sharpe | max DD | character |
|---|---:|---:|---:|---:|---|
| CORE (daily momentum) | 65.3% | 75.4% | 1.04 | −67.8% | high-octane trend engine |
| BTC1H (1H pullback) | 10.9% | 17.4% | 0.68 | −24.3% | steady, low-vol intraday |
| ETH8H (8H pullback) | 32.5% | 31.3% | 1.05 | −36.8% | punchy, fat-tailed intraday |

### 2.2 Correlation matrix — the diversification test
|  | CORE | BTC1H | ETH8H |
|---|---:|---:|---:|
| **CORE** | 1.00 | 0.04 | 0.08 |
| **BTC1H** | 0.04 | 1.00 | −0.05 |
| **ETH8H** | 0.08 | −0.05 | 1.00 |

All off-diagonals |ρ| < 0.09. The intraday edges carry information the daily
momentum book does not — exactly the property that makes a combination worth doing.
*(Caveat: intraday streams are sparse — 0 on no-trade days — which mechanically damps
Pearson ρ; but the economic logic, daily-trend vs intraday-mean-pullback, is genuinely
near-orthogonal.)*

### 2.3 Combined vs CORE-only (fixed 70/15/15, m=1)
| book | CAGR | ann vol | Sharpe | Sortino | max DD | Calmar |
|---|---:|---:|---:|---:|---:|---:|
| CORE only | 65.3% | 75.4% | 1.04 | 1.43 | **−67.8%** | 0.96 |
| **COMBINED** | 60.7% | 53.5% | **1.15** | **1.56** | **−46.7%** | **1.30** |

Lower vol, higher Sharpe/Sortino/Calmar, ~21 points less drawdown. This is the robust
headline (1821 daily observations).

### 2.4 Annual $100k wrapper — % of full years banking +50% (4 overlap years, noisy)
| book | m=2 | m=3 |
|---|---:|---:|
| CORE only | 2/4 | 3/4 |
| COMBINED (fixed 70/15/15) | **3/4** | 2/4 |
| COMBINED (alloc walk-forward) | **3/4** | **3/4** |

The %-banking metric is **leverage-sensitive and thin** (only 2022–2025 fully overlap
the intraday OOS). Read it as secondary to §2.3. The fully-OOS **allocation
walk-forward** (weights chosen each year from prior data; it picked **60/20/20** every
year) banks **3/4 (75%)** at both leverages. Per-year (alloc-WF, m=3): 2022 **−43%**,
2023 +64%, 2024 **+87%**, 2025 +51% — it **rescued 2024** (CORE-only stopped out at
−42% there) and, like every long-only construction, **missed the 2022 crash**.

---

## 3. Deployable configuration

| Sleeve | Capital | Exact rule |
|---|---:|---|
| **CORE** | 70% | Daily book = 0.60·trend + 0.40·cross-sectional over SOL/ETH/BTC/DOGE/XRP, long-only, inverse-vol (target 60%, cap 3×), book gross ≤ 2×. Full spec: `DEPLOYABLE_STRATEGY_BUILD.md`. |
| **BTC1H** | 15% | Long BTC on 1H when `close>SMA(50)` & `ADX(14)≥30` & `RSI(7)≤35`; ±3% bracket, 48h time-stop; one position; long-only. |
| **ETH8H** | 15% | Long ETH on 8H when `close>SMA(50)` & `ADX(14)≥20` & `RSI(7)≤45`; **TP 3×ATR / SL 1.5×ATR**, 12-bar stop; long-only. |

Account: $100k annual reset, **+50% profit-lock / −40% stop**, whole-book leverage
**m = 2–3** (the −40% stop is mandatory). The fixed 70/15/15 is the conservative
documented default; the OOS allocation walk-forward preferred **60/20/20** — both are
inside the robust band, pick one and keep it fixed. A live run today targets:
**CORE → ETH 39% / DOGE 39%** (the qualifying uptrends), plus the two intraday sleeves
armed on their dip triggers.

---

## 4. Honest caveats
- **2022 is the shared structural miss.** Every long-biased sleeve loses in a
  synchronized all-coin crash; the combination softens but does not escape it. This is
  not a no-down-years system.
- **The annual %-banking is judged on only 4 overlap years** (intraday OHLC starts
  2020-05). It is noisy and leverage-sensitive; the Sharpe/Calmar/maxDD improvement
  (§2.3, 1821 obs) is the trustworthy claim.
- **ETH8H is high-variance** (6/15 of its own folds negative; fat-tailed); it is sized
  small for that reason. Do not scale it up chasing the +307% standalone headline.
- **Intraday PnL is bucketed to the trade's exit day** — a modeling simplification
  (no intraday mark-to-market); fine for the small intraday allocations and short
  holds, but it makes the intraday daily series lumpy.
- **Leverage applies to the whole book.** Running the intraday sleeves at the core's
  m=2–3 is aggressive; in live trading consider levering only the daily core and
  keeping the intraday sleeves nearer 1×. Past performance is not predictive — paper
  first, respect the stops.

## 5. Reproduce
```bash
cd research
python3 unified_bot.py     # builds the 3 sleeves, prints the validation, writes artifacts
```
Outputs `results/unified_bot_results.json` (sleeve metrics, correlation, combined vs
core, annual wrapper, alloc-WF choices) and `results/unified_bot_equity.csv`
(core vs combined equity curves). Depends on the cached daily panel (`research/data/`)
and BTC/ETH 1H OHLC (`research/data/intraday/`).
