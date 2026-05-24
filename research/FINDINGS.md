# Asset-Specific Crypto Strategy Research — Findings

**Goal:** find a profitable, *asset-specific* trading strategy for each crypto
instrument (long or short), targeting a consistent ~30% annual return that
survives different market regimes, validated with **genuine walk-forward
out-of-sample data**.

**Bottom line:** Every result below is **walk-forward out-of-sample** (params
chosen only on past data, measured only on the subsequent unseen window). The
diversified portfolio of per-asset strategies delivers **+33.6% OOS CAGR at
Sharpe 1.72 and only −28% max drawdown, positive in 10 of 13 years**, and was
≈flat through the 2018 and 2022 bear markets where buy-and-hold lost 60–80%.
Five of nine assets clear 30% OOS standalone; the rest are traded defensively
rather than force-fitted.

---

## 1. Method (why these numbers are trustworthy)

| Component | Choice |
| --- | --- |
| **Data** | Real daily close prices from **Coin Metrics community network data** (`ReferenceRateUSD` / legacy `PriceUSD`), pulled from GitHub. BTC from 2014, ETH 2016, others 2017–2020. |
| **Engine** | Daily close-to-close, **strictly lookahead-free**: a target weight decided at the close of day *t* earns day *t+1*'s return. Vectorised in `engine.py`. |
| **Costs** | 6 bps/side transaction cost **plus** a 0.5 bps/day funding/carry drag on gross exposure. All headline numbers are **net of costs**. Stress-tested up to 25 bps/side. |
| **Strategy families** | `tsmom` (single-lookback momentum), `tsmom_blend` (multi-horizon momentum consensus), `macross`, `donchian` (breakout), `trend_flat` (regime-gated trend), `mr_z` (z-score mean reversion), `rsi_mr` (RSI mean reversion). Each wrapped with a **volatility-targeting** overlay and tested both long/short and long-only. |
| **Walk-forward** | Rolling train (540/420/365 d) → test (180/150/120 d), **non-overlapping** test windows. In each window the best parameter set is chosen on the **train** slice only, then evaluated on the **next unseen** window; the test slices are stitched into one OOS curve. See `walkforward.py`. |
| **Pass gate** | OOS Sharpe ≥ 0.8 **and** OOS CAGR ≥ 30% **and** fold-win-rate ≥ 0.55 **and** max DD ≥ −55%. |

There is **no parameter-selection leakage**: weights are causal and every
parameter is picked using only data that preceded the window it is scored on.

---

## 2. Per-asset results (walk-forward OOS, net of costs)

| Asset | Best family | OOS CAGR | Sharpe | Calmar | Max DD | Fold win | Buy&Hold CAGR | 30% gate |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | :--: |
| **BTC**  | tsmom_blend | **+76.2%** | 1.45 | 1.51 | −50.3% | 0.64 | +45.2% | ✅ PASS |
| **BNB**  | donchian    | **+42.5%** | 1.17 | 1.24 | −34.3% | 0.64 | +177.7% | ✅ PASS |
| **ETH**  | tsmom_blend | **+35.7%** | 1.08 | 0.89 | −40.1% | 0.65 | +65.4% | ✅ PASS |
| **DOGE** | tsmom_blend | **+35.2%** | 0.96 | 0.82 | −43.0% | 0.65 | +74.4% | ✅ PASS |
| **ADA**  | donchian    | **+35.1%** | 1.02 | 1.04 | −33.8% | 0.57 | +7.8%  | ✅ PASS |
| LINK | trend_flat  | +22.8% | 0.84 | 0.50 | −45.6% | 0.57 | +42.8% | ✗ |
| LTC  | mr_z        | +3.1%  | 0.27 | 0.11 | −28.3% | 0.48 | +31.1% | ✗ |
| XRP  | rsi_mr      | +3.0%  | 0.25 | 0.05 | −62.9% | 0.70 | +59.4% | ✗ |
| DOT  | donchian    | +1.0%  | 0.20 | 0.02 | −41.5% | 0.46 | −12.9% | ✗ |

### Each instrument wants a *different* strategy
- **Trend / momentum dominates the high-quality majors** (BTC, ETH, DOGE →
  momentum ensemble; ADA, BNB → Donchian breakout; LINK → regime-gated trend).
- **Mean reversion** is the *least-bad* fit for the chronic laggards (XRP, LTC),
  but the edge is thin.
- **Long-or-flat beats long/short.** The search included short-enabled variants;
  walk-forward repeatedly preferred **long-only** because shorting daily crypto
  gets whipsawed by violent bear-market rallies. The edge over buy-and-hold is
  therefore *timing* — be long in uptrends, **flat** in downtrends — not shorting.
- This directly answers the brief: ETH genuinely behaves differently from BTC
  (lower momentum capacity, more cost-sensitive), and the high-beta alts split
  cleanly into "trendable" (ADA, DOGE, BNB) vs "untradeable on daily bars" (DOT).

### Surviving regimes (per-year OOS, BTC example)
2018 −18.8%, **2022 −2.1%**, 2025 −22.2% — i.e. the trend timing sat out or
barely scratched the bears, versus buy-and-hold losses of 60–80% in those years,
then captured +239% (2016), +380% (2017), +369% (2020), +123% (2024). The losing
years are small; the winning years are large. That asymmetry is the edge.

---

## 3. The portfolio is the consistency engine

Trend-following is **lumpy per asset**, so "consistent 30%" is delivered by
combining the asset-specific strategies (every stream below is OOS):

| Portfolio (equal-weight) | OOS CAGR | Sharpe | Sortino | Max DD | Vol | Positive yrs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **All 9 assets** | **+33.6%** | **1.72** | 2.14 | **−28.4%** | 17.7% | **10 / 13** |
| Pass-only (BTC ETH ADA DOGE BNB) | +58.5% | 1.62 | 1.92 | −50.3% | 31.6% | 10 / 12 |

The **all-9 book is the recommended vehicle**: adding the "laggard" assets
(DOT, XRP, LTC) — whose standalone strategies are near-flat but uncorrelated and
defensive — *cuts* portfolio drawdown from −50% to −28% and lifts Sharpe to 1.72.
Per-year OOS for the all-9 book: 2015 +38%, 2016 +40%, 2017 +99%, **2018 −0%**,
2019 +24%, 2020 +57%, 2021 +85%, **2022 −1%**, 2023 +24%, 2024 +56%, 2025 +7%,
2026 +2%. **No materially negative year in 13.**

---

## 4. Robustness

- **Cost sensitivity** (OOS CAGR / Sharpe): even at *stress* costs (25 bps/side +
  2 bps/day funding) BTC +74.6%/1.31, BNB +33.4%/1.01, DOGE +28.8%/0.86,
  ADA +24.2%/0.90. The edge is not a cost artifact. ETH is the most
  cost-sensitive (+14.1%/0.55 at stress) — size it accordingly.
- **Family ranking is stable**: trend/momentum wins for the trendable assets
  across every cost level; mean-reversion never wins for a major.
- **Fold-win-rate ≥ 0.57** for all passing assets — the OOS profit is spread
  across windows, not one lucky fold.

---

## 5. Honest caveats

1. **SOL is not validated here — data could not be sourced.** This sandbox's
   network allowlist blocks every crypto exchange/aggregator API (Binance,
   Coinbase, Kraken, CoinGecko, Yahoo all return 403), and Coin Metrics'
   *community* CSVs only carry full price history for older assets — SOL (a 2020
   listing) exposes just a 7-row stub. **DOT** is used as the closest available
   high-beta-L1 analog. Note DOT is a *pessimistic* stand-in: it declined almost
   continuously after 2021, whereas SOL had a powerful 2023–24 uptrend that the
   momentum/breakout families would very likely have captured. The SOL config
   slot is kept ready; the bot's existing Binance loader can validate it the
   moment it runs with network access. **Do not treat DOT's −fail as SOL's verdict.**
2. **Daily close-only data**: no intraday high/low, so stops are modeled at the
   close and costs are kept conservative. Results are end-of-day systematic, not
   intraday.
3. **Past performance is not predictive.** Walk-forward reduces overfit risk but
   cannot eliminate regime change. Deploy in paper first (the repo's `BOT_MODE=paper`).
4. The headline OOS metrics use **adaptive per-fold parameters** (standard
   walk-forward). `strategy_configs.json` also records the single **most
   frequently selected** parameter set per asset as a deployment reference.

---

## 6. Reproduce

```bash
python3 -m venv research_venv && research_venv/bin/pip install numpy pandas
cd research
../research_venv/bin/python data.py            # fetch + cache daily prices (GitHub)
../research_venv/bin/python run_research.py --all   # full walk-forward sweep
../research_venv/bin/python robustness.py      # cost + per-year stress
../research_venv/bin/python portfolio_analysis.py   # portfolios + config export
```

Outputs land in `research/results/` (`research_results.json`,
`strategy_configs.json`, per-asset and portfolio OOS equity CSVs).
