# Best Stand-Alone Strategy per Coin — BTC, SOL, ETH, XRP, DOGE

Each coin optimised **on its own data**, walk-forward out-of-sample, across the full
strategy family space (trend, multi-lookback blend, breakout/Donchian, EMA-cross,
z-score & RSI mean-reversion, regime orchestrator; long-only **and** long/short; spot
and futures-leverage grids). Costs 6 bps/side + 1 bp/day funding. Annualisation 365.
Reproduce: [`research/per_coin_best.py`](research/per_coin_best.py) →
`research/results/per_coin_best_results.json`. Data via Coin Metrics (BTC/ETH/XRP/DOGE,
long history) and **real SOL** via Binance Vision (2020-08-11→).

> **Read the two columns honestly.** "Expected outcome" is reported as a leveraged
> **annual-reset** model (each Jan starts at $100k). The **mean** year is inflated by a
> few explosive years; the **median** is the *typical* year and the number to anchor on.
> Leverage past ~2–3× raises the mean while **destroying the median and inviting ruin**
> (−100% years). The recommended config maximises the *typical* year while staying
> survivable, not the headline mean.

---

## Headline finding

The **same engine wins for four of the five coins**: a **long-only multi-lookback
momentum ensemble** (`tsmom_blend`) with inverse-volatility sizing —

```
raw[t] = mean over L in [10,30,60,120] of sign( close[t]/close[t-L] - 1 )   # ∈ [0,1] long-only
rv[t]  = max( std(daily_ret, 20) * sqrt(365), 0.10 )
w[t]   = clip( max(raw[t],0) * min(0.60 / rv[t], cap), 0, cap )
```
`vol_target=0.60, vol_lb=20`. It is long only while the asset trends up across
multiple horizons, sized inversely to recent volatility, and **flat otherwise**.
XRP is the lone exception (and the weakest coin): its best fit is the long/short
`tsmom_blend` at a lower vol target.

| Coin | Best engine (risk-adjusted) | OOS CAGR (1×) | Sharpe | Sortino | maxDD | Fold-win |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| **BTC** | tsmom_blend long-only | **+102%** | **1.55** | 1.88 | −61% | 0.64 |
| **ETH** | tsmom_blend long-only | +56% | 1.20 | 1.37 | −42% | 0.65 |
| **DOGE** | tsmom_blend long-only | +57% | 1.00 | 1.42 | −49% | 0.65 |
| **SOL** (real) | tsmom_blend long-only | +28% | 0.76 | 0.85 | −56% | 0.55 |
| **XRP** | tsmom_blend long/short | +23% | 0.73 | 1.22 | −75% | 0.35 |

BTC is the standout (Sharpe 1.55, +102% CAGR even at 1×). ETH and DOGE are strong
(Sharpe ~1.0–1.2). SOL is decent but shorter history and lower Sharpe. XRP is the
weak link (low fold-win, deep −75% drawdown) — viable only small or inside a book.

---

## Per-coin detail

Each table is the leverage sweep on that coin's best OOS stream: **mean** and
**median** annual return (annual-reset, with liquidation), worst year, and ruin-year
count. ✅ marks the recommended sane leverage (best *typical* year, survivable).

### BTC — `tsmom_blend` long-only · `lbs=[10,30,60,120], vol_target=0.6, vol_lb=20`
OOS (1×): CAGR **+102%**, Sharpe **1.55**, maxDD −61%, fold-win 0.64. (Best *raw*
engine was the regime orchestrator at +107% CAGR but lower Sharpe / deeper DD.)

| m | mean/yr | median/yr | worst/yr | ruin |
| --: | --: | --: | --: | :--: |
| 1× | +183% | +88% | −30% | 0 |
| 2× ✅ | +672% | **+139%** | −72% | 0 |
| 3× | +1535% | +96% | −95% | 0 |
| 5× | +1984% | −72% | −100% | 1 |
| ≥8× | −100% | −100% | −100% | most |
**Recommended: 1–2×.** Typical year ≈ **+88% (1×) to +139% (2×)**; beyond 2× the
median rolls over and a −95%/−100% year appears.

### ETH — `tsmom_blend` long-only · `lbs=[10,30,60,120], vol_target=0.6, vol_lb=20`
OOS (1×): CAGR **+56%**, Sharpe **1.20**, maxDD −42%, fold-win 0.65.

| m | mean/yr | median/yr | worst/yr | ruin |
| --: | --: | --: | --: | :--: |
| 1× | +72% | +24% | −18% | 0 |
| 2× ✅ | +194% | +27% | −35% | 0 |
| 3× | +361% | +27% | −51% | 0 |
| 5× | +567% | +1% | −98% | 0 |
| ≥8× | −25%→−100% | −95% | −100% | 3+ |
**Recommended: 2–3×.** Typical year ≈ **+27%** (the +361% "mean" at 3× is a few big
years, not the norm); deep down-months/years are part of the deal (see §18 ETH study).

### DOGE — `tsmom_blend` long-only · `lbs=[10,30,60,120], vol_target=0.6, vol_lb=20`
OOS (1×): CAGR **+57%**, Sharpe **1.00**, maxDD −49%, fold-win 0.65.

| m | mean/yr | median/yr | worst/yr | ruin |
| --: | --: | --: | --: | :--: |
| 1× | +109% | +48% | −24% | 0 |
| 2× ✅ | +348% | **+74%** | −49% | 0 |
| 3× | +825% | +32% | −70% | 0 |
| 5× | +2985% | −9% | −95% | 0 |
| ≥8× | huge mean | −93%→−100% | −100% | 4+ |
**Recommended: 2×.** Typical year ≈ **+74%**; DOGE has the fattest right tail (mean
explodes with leverage) but the median peaks at 2× then falls.

### SOL — `tsmom_blend` long-only · `lbs=[10,30,60,120], vol_target=0.6, vol_lb=20`
OOS (1×): CAGR **+28%**, Sharpe **0.76**, maxDD −56%, fold-win 0.55. (Real SOL,
2020-08→; only ~4 full years, so less robust than the others.)

| m | mean/yr | median/yr | worst/yr | ruin |
| --: | --: | --: | --: | :--: |
| 1× | +44% | +31% | −21% | 0 |
| 2× ✅ | +87% | **+39%** | −51% | 0 |
| 3× | +112% | +22% | −77% | 0 |
| ≥5× | +53%→−100% | −42%→−98% | −99%/−100% | 0→4 |
**Recommended: 1–2×.** Typical year ≈ **+31–39%**; short history ⇒ treat with caution.

### XRP — `tsmom_blend` **long/short** · `lbs=[10,30,60,120], vol_target=0.2, vol_lb=30, max_lev=3`
OOS (1×): CAGR **+23%**, Sharpe **0.73**, maxDD **−75%**, fold-win **0.35** (weak).

| m | mean/yr | median/yr | worst/yr | ruin |
| --: | --: | --: | --: | :--: |
| 1× ✅ | +53% | +4% | −36% | 0 |
| 2× | +213% | +5% | −60% | 0 |
| 3× | +607% | +5% | −76% | 0 |
| ≥5× | huge mean | −9%→−100% | −93%/−100% | 0→8 |
**Recommended: 1× and small (or exclude).** The **median year is only ~+4–5%** — XRP's
returns are episodic (a couple of giant years, many flat/negative). The high "mean" at
leverage is almost entirely two outlier years; do not size XRP on it.

---

## Cross-coin takeaways
1. **One engine rules:** long-only multi-lookback momentum (`tsmom_blend`,
   `lbs=[10,30,60,120]`, vol-target 0.6) is the best stand-alone strategy for BTC,
   ETH, DOGE and SOL — robust, few parameters, generalises OOS. This is the engine to
   build per coin.
2. **Ranking by quality:** BTC (Sharpe 1.55) ≫ ETH (1.20) ≈ DOGE (1.00) > SOL (0.76) >
   XRP (0.73, but deep DD and low fold-win).
3. **Sane leverage is 1–3×.** Median (typical-year) return peaks at **1–2× for
   BTC/SOL/XRP and 2–3× for ETH/DOGE**; past that the mean keeps rising but the median
   collapses and −95%/−100% ruin years appear. Highest *survivable* expected typical
   year: **BTC +88–139%, DOGE +74%, SOL +31–39%, ETH +27%, XRP +4%.**
4. **XRP is the weak link** — episodic, low fold-win, −75% DD; run tiny or only inside
   a diversified book.
5. **Honesty:** these are excellent single-coin momentum bots, not magic. Returns are
   lumpy (concentrated in trend years), drawdowns are deep, and the leveraged "mean"
   is outlier-driven. Paper-trade first; size by the median and the worst year, not the
   mean. Execution/risk layer and the multi-coin book: see
   [`DEPLOYABLE_STRATEGY_BUILD.md`](DEPLOYABLE_STRATEGY_BUILD.md) and `SOFTWARE_SPEC.md`.
