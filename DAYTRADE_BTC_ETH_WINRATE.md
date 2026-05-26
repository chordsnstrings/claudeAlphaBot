# Day-trading BTC & ETH for the highest win rate — 1H / 8H / 12H / 1D

> **Goal.** Acting as a day trader, find the most profitable way to trade BTC & ETH
> on 1H, 8H, 12H and 1D candles, optimised for the **highest win rate** — and prove
> it honestly: win rate reported **next to** the things that decide whether it is
> worth anything (net return after fees, profit factor, expectancy, drawdown), with
> entries lookahead-free and out-of-sample validation.

**Every headline number is out-of-sample and net of a 6 bps/side (12 bps round-trip)
taker cost.** Parameters are chosen only on past data and scored only on later,
unseen data. Code: [`research/daytrade_winrate.py`](research/daytrade_winrate.py),
[`research/daytrade_walkforward.py`](research/daytrade_walkforward.py),
[`research/daytrade_rr_tradeoff.py`](research/daytrade_rr_tradeoff.py).

---

## TL;DR verdict

1. **Win rate alone is a trap — it is a free dial.** With a naive 1H dip-buy
   (RSI<30) you can manufacture an **~80% win rate** by using a tight take-profit
   and a wide stop — and still **lose ~90% of capital**, because the rare wide-stop
   loss eats all the small wins. Across every TP/SL geometry on both coins,
   expectancy stayed **negative** (≈ −0.27%/trade) *regardless* of win rate. So "the
   option with the highest win rate" is, by itself, a losing strategy. The right
   target is **the highest win rate that is still net-positive out-of-sample.**

2. **Pure intraday mean reversion (z-score / RSI) fails after costs**, worst of all
   on 1H — the most data-rich timeframe — losing 58–90% OOS on both coins. A high
   *in-sample* win rate (ETH 1H hit 70–72% on train) **collapsed OOS** (→ 25–40%).

3. **The one edge that survives is a trend filter, not reversion geometry:**
   *buy the dip only when the higher-timeframe trend is up* (price > slow SMA, then a
   short-term RSI dip), exit on a symmetric bracket. This **`trend_pullback`** family
   is the only one that stayed net-positive OOS with a **trustworthy trade count**.

4. **Best honest answer (rolling walk-forward, §3.2): exactly one of 24 tested
   coin×timeframe×family combinations survives — `BTC 1H trend_pullback`**, at a
   **53.1% out-of-sample win rate, +63.9% net, profit factor 1.22, positive in 60% of
   15 multi-regime windows.** That ~53% is the *sustainable* day-trade win-rate ceiling
   — not the 80% the win-rate dial advertises. **ETH has no walk-forward-robust intraday
   edge** (best cell −18.5%), and the edge does **not** carry to 8H/12H/1D — it is
   specifically *buying BTC 1H dips in an uptrend.*

> This reconciles exactly with the rest of the repo: BTC/ETH **direction is
> unpredictable** at short horizons ([`PREDICTION_ACCURACY_BTC_ETH.md`](PREDICTION_ACCURACY_BTC_ETH.md)),
> and the only durable structure is **trend/momentum + volatility**
> ([`PATTERNS_BTC_ETH.md`](PATTERNS_BTC_ETH.md)). A day-trade book cannot conjure a
> directional edge that the data does not contain; the most it can do is borrow the
> *trend* edge with a pullback entry — which is precisely what survives here.

---

## 1. Data & engine

| Component | Choice |
| --- | --- |
| **Data** | Real Binance spot OHLCV, **1H candles, BTC & ETH, 2020-05-26 → 2026-05-25 (52,537 bars each)**, via the public `data-api.binance.vision` mirror. Resampled to **8H / 12H / 1D** anchored at 00:00 UTC. |
| **Why this is new** | The repo's earlier daily study was **close-only** (no intraday high/low), so it could not model real intrabar stops or measure trade-level win rate. This study uses true **OHLC bracket fills** — the right tool for a win-rate question. |
| **Entry** | Signal computed on bar *t*'s **close**; fill at bar *t+1*'s **open**. No lookahead. |
| **Exit** | Bracket: take-profit + stop-loss (% of entry), plus a time-stop after *N* bars. Intrabar fills use high/low; **gaps fill at the open**; if one bar's range spans **both** TP and SL we assume the **stop** filled first (worst case) so win rate is never optimistically inflated. |
| **Position** | One at a time, 1× (a focused day-trade book). Leverage scales P&L and ruin risk linearly but does **not** change win rate. |
| **Costs** | 6 bps/side = 12 bps round-trip taker. Conservative for a retail high-turnover book (maker/limit entries would be cheaper). |
| **Validation** | (a) single 70/30 train→test split for the landscape; (b) **rolling walk-forward** with non-overlapping 120-day test windows across 2021→2026 for the verdict. Params chosen on train only. |

Strategy families swept (long/short and long-only):
`zscore_mr` (Bollinger/z-score reversion), `rsi_mr` (RSI reversion),
`trend_pullback` (trend-filtered dip-buy / pop-sell). Each over a grid of
lookbacks, thresholds, TP/SL brackets and hold times sized per timeframe.

---

## 2. The win-rate trap (why "highest win rate" is the wrong question)

Fixed naive entry (1H, buy when RSI(14) < 30, hold ≤ 24h), **only** the TP:SL
geometry varied. Full sample, net of cost
([`research/daytrade_rr_tradeoff.py`](research/daytrade_rr_tradeoff.py)):

| TP% | SL% | BTC win | BTC net | BTC exp/trade | ETH win | ETH net | ETH exp/trade |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 0.5% | 3.0% | **79.4%** | −89.6% | −0.271% | **80.1%** | −95.6% | −0.295% |
| 0.5% | 2.0% | 73.6% | −92.1% | −0.270% | 72.7% | −96.7% | −0.296% |
| 1.0% | 3.0% | 66.7% | −87.6% | −0.300% | 69.7% | −91.5% | −0.275% |
| 1.0% | 1.0% | 44.7% | −89.2% | −0.226% | 42.4% | −95.9% | −0.270% |
| 3.0% | 1.0% | 24.8% | −92.8% | −0.291% | 22.1% | −97.2% | −0.338% |
| 4.0% | 1.0% | 23.3% | −91.9% | −0.278% | 20.2% | −96.9% | −0.328% |

**Win rate ranges from 20% to 80% — and net P&L is uniformly catastrophic.** Tighten
the TP and you win four times out of five; it changes nothing, because the entry has
no directional edge and expectancy is ~constant and negative once costs are paid.
This is the single most important fact for a day trader chasing win rate.

---

## 3. Single-split landscape (70/30) — what even *looks* viable OOS

OOS leaderboard: configs net-positive on the unseen test slice (2024-08 → 2026-05),
with ≥12 test trades, ranked by test win rate
([`research/results/daytrade_winrate_results.json`](research/results/daytrade_winrate_results.json)):

| coin | tf | family | test win | test net | PF | test DD | n |
|---|---|---|---:|---:|---:|---:|---:|
| BTC | 12h | zscore_mr | 83.3% | +28.5% | 3.89 | −8.9% | **12** ⚠️ |
| ETH | 12h | rsi_mr | 58.6% | +16.0% | 1.36 | −15.8% | 29 |
| **BTC** | **1h** | **trend_pullback** | **57.9%** | **+11.4%** | 1.24 | −9.8% | **95** ✅ |
| ETH | 12h | trend_pullback | 55.0% | +29.3% | 2.06 | −9.6% | 20 |
| **BTC** | **1h** | **trend_pullback** | **53.4%** | **+29.5%** | 1.33 | −10.7% | **88** ✅ |
| ETH | 1d | rsi_mr | 52.2% | +1.0% | 1.06 | −22.3% | 23 |
| ETH | 12h | rsi_mr | 43.8% | +12.6% | 1.35 | −11.0% | 32 |
| ETH | 8h | trend_pullback | 42.1% | +13.2% | 1.26 | −14.6% | 57 |

The eye-catching **83.3% (BTC 12H)** sits on **n=12** trades — at the trust floor, a
huge confidence interval, almost certainly part luck. The only entries with a
**large, trustworthy OOS sample** are **BTC 1H `trend_pullback`** (n=88–95), at
**53–58% win** and clearly net-positive. Everything reversion-based on 1H is deeply
negative; the higher-TF "winners" rest on thin samples.

### 3.1 Per-year robustness of the headline config (the real win-rate profile)

Full-sample, single fixed config — **BTC 1H trend-filtered pullback** (long when
`close > SMA(50)` and `RSI(7) ≤ 35`, symmetric ±3% bracket, 48h time-stop):
**n=279, 54.8% win, +141.3% net, PF 1.34, max DD −22.6%**
([`research/daytrade_inspect.py`](research/daytrade_inspect.py)).

| Year | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Trades | 25 | 56 | 39 | 44 | 48 | 47 | 20 |
| **Win rate** | 56% | 63% | 46% | 46% | 69% | 47% | 55% |
| Net | +7% | +32% | +1% | −4% | +71% | −2% | +5% |

The win rate centres on **~55%** and the edge is **regime-dependent**: it earns big
in trends (2021, 2024), and is roughly **flat in chop/bear** (2022, 2023, 2025) —
it does *not* lose much in bad years because the trend filter keeps it out of
sustained downtrends. This is the honest shape of a real day-trade edge: a coin-
flip-plus, paid off by trend years, not an 80% money printer.

> **Config fragility / why we select on expectancy, not win rate.** A *different*
> BTC 1H pullback config (`SMA(200)`, dip 40) looked like a **57.9% winner** on the
> single 70/30 test window — but it is **net −52.6% over the full sample** (win 46%).
> The test window (2024-25, trending) flattered it. Selecting parameters by
> **expectancy** (which favoured `SMA(50)`) generalised; selecting by **win rate**
> did not. Multi-fold rolling walk-forward (below) is the arbiter that exposes this.

### 3.2 Rolling walk-forward (multi-regime confirmation)

Rolling walk-forward (train 365d → unseen 120d, **15 non-overlapping windows**
across 2021→2026; params re-chosen on each train window) is the decisive test —
it samples the 2022 bear, 2023 chop and 2025 selloff, not one friendly window.
Reported in
[`research/results/daytrade_walkforward_results.json`](research/results/daytrade_walkforward_results.json)
(code: [`research/daytrade_walkforward.py`](research/daytrade_walkforward.py)).

**Complete grid — every coin × timeframe × family (net of cost, pooled OOS):**

| coin | tf | family | OOS trades | **OOS win** | OOS net | PF | fold-win-rate |
|---|---|---|---:|---:|---:|---:|---:|
| **BTC** | **1h** | **trend_pullback** | **258** | **53.1%** | **+63.9%** | **1.22** | **60%** ✅ |
| BTC | 1h | zscore_mr | 819 | 50.4% | −63.3% | 0.93 | 33% |
| BTC | 1h | rsi_mr | 394 | 45.9% | −65.6% | 0.81 | 29% |
| BTC | 8h | trend_pullback | 128 | 47.7% | −27.0% | 0.84 | 33% |
| BTC | 8h | zscore_mr | 220 | 45.0% | −58.3% | 0.76 | 33% |
| BTC | 8h | rsi_mr | 177 | 38.4% | −57.5% | 0.68 | 13% |
| BTC | 12h | trend_pullback | 81 | 40.7% | −19.4% | 0.87 | 43% |
| BTC | 12h | zscore_mr | 116 | 45.7% | −36.1% | 0.84 | 43% |
| BTC | 12h | rsi_mr | 122 | 42.6% | −41.8% | 0.79 | 53% |
| BTC | 1d | trend_pullback | 102 | 39.2% | −43.5% | 0.72 | 40% |
| BTC | 1d | zscore_mr | 131 | 51.9% | −21.8% | 0.94 | 40% |
| BTC | 1d | rsi_mr | 76 | 44.7% | −7.1% | 0.98 | 50% |
| ETH | 1h | trend_pullback | 203 | 49.8% | −18.5% | 0.93 | 53% |
| ETH | 1h | zscore_mr | 1413 | 44.0% | −96.2% | 0.83 | 13% |
| ETH | 1h | rsi_mr | 174 | 42.5% | −61.7% | 0.58 | 29% |
| ETH | 8h | trend_pullback | 140 | 41.4% | −33.7% | 0.81 | 27% |
| ETH | 8h | zscore_mr | 249 | 34.9% | −66.9% | 0.68 | 13% |
| ETH | 8h | rsi_mr | 229 | 32.3% | −77.9% | 0.56 | 20% |
| ETH | 12h | trend_pullback | 110 | 46.4% | −48.8% | 0.77 | 27% |
| ETH | 12h | zscore_mr | 182 | 41.2% | −76.8% | 0.69 | 33% |
| ETH | 12h | rsi_mr | 105 | 41.9% | −59.8% | 0.70 | 40% |
| ETH | 1d | trend_pullback | 95 | 49.5% | −23.6% | 0.88 | 36% |
| ETH | 1d | zscore_mr | 118 | 44.9% | −49.5% | 0.81 | 33% |
| ETH | 1d | rsi_mr | 77 | 44.2% | −52.3% | 0.68 | 36% |

**This is the verdict, and it is unambiguous: of all 24 combinations, exactly ONE is
net-positive out-of-sample — `BTC 1H trend_pullback`** (53.1% win, +63.9% net, PF
1.22, **60% of 15 multi-regime windows positive**; per-fold win 30%→73%, median 50%).
Everything else loses after costs across folds:

- **Pure mean reversion fails everywhere** — a ~50% raw win rate that still bleeds
  out (PF < 1, fold-win ≈ ⅓) on every timeframe and both coins. The single-split's
  flashy "83% / 58%" reversion cells (§3) were small-sample lucky windows; multi-fold
  WF erases them.
- **The edge is timeframe-specific.** Even trend-pullback only works on **BTC 1H**;
  on 8H/12H/1D it goes negative (−19% to −44%). Higher timeframes simply don't
  generate enough day-trade opportunities for the thin edge to compound past costs.
- **ETH has no walk-forward-robust intraday edge at all.** Its best cell (1H
  trend_pullback) is −18.5%; everything else is worse. ETH's day-trade "wins" in the
  single split do not survive. (Consistent with the daily study: ETH is the most
  cost-sensitive major — it belongs in the daily momentum book, not a 1H scalp.)

So the most profitable, highest *sustainable* win-rate day-trade option on these
timeframes is a single, specific thing: **buy BTC 1H dips in an uptrend.** Its OOS
equity curve is [`research/results/dtwf_BTC_1h_trend_pullback_oos_eq.csv`](research/results/dtwf_BTC_1h_trend_pullback_oos_eq.csv).

---

## 4. Deployable rule — the best honest day-trade option

**Primary: BTC, 1H, trend-filtered pullback (long-only).**

| Parameter | Value |
|---|---|
| Trend filter | 1H `close > SMA(50)` (only trade with the higher trend) |
| Entry trigger | `RSI(7) ≤ 35` (short-term dip) → **enter long at next bar's open** |
| Take-profit | +3% from entry |
| Stop-loss | −3% from entry |
| Time-stop | exit at market after 48 hours if neither hit |
| Sizing | one position at a time; 1× (cap leverage ≤ 2–3× — at 1× the max DD is already −22%) |
| Direction | **long-only** — shorting the dips/pops did not improve OOS (consistent with the daily book) |

Expected profile (walk-forward OOS): **~53% win rate, profit factor ~1.2,
~+0.2%/trade after cost** (full-sample, the friendlier number, is 54.8% / PF 1.34 /
+0.35%), concentrated in trending months, ~flat in chop. Use **limit (maker) entries**
to beat the 12 bps round-trip assumption — costs are the main thing that can kill it.

**ETH: do not day-trade it on these timeframes.** This is the result that surprised
me, and it is worth stating plainly because the single-split made ETH look tradeable
(8H/12H showed +13–29% on one window). **Under rolling walk-forward, no ETH cell
survives** — every coin/TF/family combination is net-negative, the best being 1H
trend_pullback at **−18.5%**. ETH's intraday "wins" were lucky windows, not an edge.
ETH is the most cost-sensitive major (see [`STRATEGY_FINDINGS.md`](STRATEGY_FINDINGS.md));
its real, validated edge is **daily momentum (long-or-flat)**, not an intraday scalp.
Trade ETH on the daily book; day-trade only BTC 1H.

**What to *not* do:** (1) chase the 80% win rate (tight-TP scalp) — §2 shows it is the
worst net of all; (2) run naive 1H mean reversion on either coin (−63% to −96% OOS);
(3) day-trade either coin on 8H/12H/1D expecting the 1H edge to carry over — it does
not (all negative under walk-forward).

---

## 5. Honest caveats

- **Spot, long-biased sample.** 2020-2026 is net bullish; a trend-pullback (mostly
  long) book is helped by that. The walk-forward spans the 2022 bear and 2025
  selloff to stress this, but a structurally different future regime can still
  compress the edge.
- **Costs dominate intraday.** At 12 bps round-trip the naive books already die;
  push to 20+ bps (thin liquidity, slippage on stops) and the survivors thin out
  too. Limit/maker entries are the realistic way to defend the edge.
- **Win rate ≠ profit.** Re-read §2. Any product or signal advertising a 70–90% day-
  trade win rate on BTC/ETH is using the tight-TP dial; its expectancy after costs
  is the number that matters, and it is usually ≤ 0.
- **Past performance is not predictive.** Walk-forward reduces overfit risk; it does
  not remove regime risk. Paper-trade before risking capital.

## 6. Reproduce

```bash
pip install numpy pandas
cd research
python3 daytrade_rr_tradeoff.py            # the win-rate trap table
python3 daytrade_winrate.py BTC ETH 1h 8h 12h 1d   # single-split landscape + leaderboard
python3 daytrade_walkforward.py BTC ETH 1h 8h 12h 1d  # rolling walk-forward verdict
```
Outputs: `research/results/daytrade_winrate_results.json`,
`research/results/daytrade_walkforward_results.json`, and `dtwf_*_oos_eq.csv` curves.
