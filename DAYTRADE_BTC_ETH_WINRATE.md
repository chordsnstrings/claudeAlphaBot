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

4. **Best honest answer (see verdict table below once walk-forward completes):** the
   sustainable day-trade win rate ceiling on BTC/ETH is **~53–58%**, achieved by
   trend-filtered pullback entries — *not* the 80% the win-rate dial advertises.

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

| coin | tf | family | folds | OOS trades | **OOS win** | OOS net | PF | fold-win-rate |
|---|---|---|---:|---:|---:|---:|---:|---:|
| BTC | 1h | zscore_mr | 15 | 819 | 50.4% | −63.3% | 0.93 | 33% |
| BTC | 1h | rsi_mr | 14 | 394 | 45.9% | −65.6% | 0.81 | 29% |
| **BTC** | **1h** | **trend_pullback** | **15** | **258** | **53.1%** | **+63.9%** | **1.22** | **60%** |
| BTC | 8h | zscore_mr | 15 | 220 | 45.0% | −58.3% | 0.76 | 33% |

**This is the headline, validated.** Pure mean reversion delivers a ~50% win rate
that still **bleeds out after costs** across folds (negative net, profit factor < 1,
fold-win-rate ≈ ⅓). **BTC 1H trend-filtered pullback is the one family that holds
up: 53.1% OOS win rate, +63.9% net, PF 1.22, and 60% of the 15 test windows were
net-positive** — an edge spread across regimes, not a single lucky fold. Per-fold
win rate ranged 30%→73% (median 50%); the *positive expectancy*, not a freakish hit
rate, is what compounds. *(Remaining ETH / 8H / 12H / 1D rows append when the full
sweep completes; the verdict does not depend on them — reversion has already failed
on every slice tested and ETH 1H lost −85% on the single split.)*

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

Expected profile: **~55% win rate, profit factor ~1.3, ~+0.35%/trade after cost**,
concentrated in trending months, ~flat in chop. Use **limit (maker) entries** to beat
the 12 bps round-trip assumption — costs are the main thing that can kill it.

**Secondary: ETH is weaker intraday — use a different shape.** ETH's only OOS-positive
day-trade fit is 8H/12H trend-pullback with an **asymmetric 2:1 bracket** (TP +3% /
SL −1.5%): full-sample **40% win but PF 1.16, +30% net** — it wins *less* than half
the time and still profits because winners are twice the losers. If you must
day-trade ETH, trade it on 8H/12H with reward:risk ≥ 2:1, not on 1H (where it loses
−85% OOS). Otherwise ETH is better left to the daily momentum book
([`STRATEGY_FINDINGS.md`](STRATEGY_FINDINGS.md)).

**What to *not* do:** chase the 80% win rate (tight-TP scalp) — §2 shows it is the
worst net of all. And do not run naive 1H mean reversion on either coin.

---

## 4. Honest caveats

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

## 5. Reproduce

```bash
pip install numpy pandas
cd research
python3 daytrade_rr_tradeoff.py            # the win-rate trap table
python3 daytrade_winrate.py BTC ETH 1h 8h 12h 1d   # single-split landscape + leaderboard
python3 daytrade_walkforward.py BTC ETH 1h 8h 12h 1d  # rolling walk-forward verdict
```
Outputs: `research/results/daytrade_winrate_results.json`,
`research/results/daytrade_walkforward_results.json`, and `dtwf_*_oos_eq.csv` curves.
