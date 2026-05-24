# Crypto walk-forward research: regime-gated momentum

Search for an autonomous method delivering a **consistent ~30% annual return on
crypto perpetual futures**, validated by rolling walk-forward (the strategy is
only ever judged on out-of-sample data). This records the method, the honest
results, what the regime ("orchestrator") layer did, and the real limits.

## Data

CoinMetrics community daily reference prices (`PriceUSD`), loaded via
`pnpm --filter @trading/cli ingest:crypto` from
`raw.githubusercontent.com/coinmetrics/data`. The universe was later expanded to
**24 assets** (every CoinMetrics major exposing a `PriceUSD` column) for the
cross-sectional tests; the directional headline result below uses these seven
longest-history liquid majors:

| Instrument | History |
|---|---|
| BTCUSDT | 2010-07 → 2026-05 |
| ETHUSDT | 2015-08 → |
| LTCUSDT | 2013-04 → |
| XRPUSDT | 2014-08 → |
| DOGEUSDT | 2014-01 → |
| BNBUSDT | 2017-07 → |
| ADAUSDT | 2017-12 → |

Codes use the USDT-margined perp convention so sizing/friction branch to crypto
contract rules (1 lot = 1 coin). **Data-fidelity caveat:** like the Fed FX
series, these are one price/day, so bars are `O=H=L=C` — no intrabar high/low.
This is fine for **close-based momentum/breakout** but makes tight-stop
mean-reversion untrustworthy (an intrabar wick through a tight stop is
invisible). SOL and several alts are excluded — the community tier has no
`PriceUSD` column for them.

**Modelling honesty (perps):** the underlying is a *spot reference rate*, not a
futures mark; we treat it as the perp underlying and charge funding separately.
Friction = deterministic 6 bps/side all-in (taker + spread + slippage) plus
**1 bp/day funding** charged to both directions (~3.65%/yr drag — momentum is
long in bull funding regimes and short in bear, so funding ≈ always a cost).
Basis/term-structure is not modelled.

## Method: regime-gated multi-horizon momentum

`@trading/strategies/TimeSeriesMomentumStrategy` with the **regime gate** added
for crypto. Per asset, on each daily bar:

1. **Momentum core** — trailing return at three horizons (126 / 63 / 31 days for
   the headline config); hold **long** only if all three are positive, **short**
   only if all three are negative, else flat. Exit on signal flip. Wide 20×ATR
   disaster stop only.
2. **Regime gate (the "right strategy at the right time" selector):**
   - **Trend filter** — only hold a position when `ADX(14) ≥ 20`. In choppy,
     trendless regimes (ADX below the floor) the strategy sits in **cash**.
   - **Direction filter** — only go long above `SMA(200)`, short below it.
     Blocks counter-trend entries during V-reversals where momentum briefly
     agrees against the dominant regime.

The gate is the meta-layer: it switches each asset between *momentum* and *cash*
based on its regime. On close-only data the only honest alternatives to momentum
are cash or the opposite-direction trend, so "select the strategy" reduces to
**trend-vs-cash + long-vs-short**, which is exactly what the gate does.

Sizing: risk a fixed fraction of equity to the ATR-based stop (so position size
is inherently inverse to volatility — per-asset vol targeting), capped at 3×
notional leverage. Risk-based caps relaxed to crypto scale.

## Results (out-of-sample, walk-forward)

7 OOS years, 2020–2026, 24-month train / 12-month test windows, 7-asset book,
1%/trade risk, 3× leverage cap, headline config (ADX≥20, SMA200, 126-day
lookback):

| OOS year | Annual return (on fixed 100k) |
|---|---|
| 2020 | +25% |
| 2021 | **+418%** (bull blow-off) |
| 2022 | +37%  (bear — captured via shorts) |
| 2023 | +13% |
| 2024 | +75% |
| 2025 | **−34%** (the one losing year) |
| 2026* | +8% (partial) |

- **Compound CAGR ≈ 49%/yr** over the 6.3-year span (final equity ≈ 12.5×).
- **Positive in 6 of 7 years (86%).**
- **Worst year −34%** (annual-granularity max-drawdown ≈ 34%).
- Median year **+25%**, mean **+77%** (mean skewed by the 2021 blow-off).
- Mean expectancy **+1.49R** per trade.

### Robustness (not a curve-fit)

Every perturbation of the gate around the headline config stays strongly
positive, 71–86% of windows profitable — the edge is a property of the *method*,
not the exact numbers:

| Variant | Net OOS (7y, 1%/trade) | Profitable windows | Expectancy |
|---|---|---|---|
| ADX≥20, SMA200, lb126 (headline) | +$542k | 86% | +1.49R |
| ADX≥15, SMA200, lb126 | +$556k | 71% | +1.54R |
| ADX≥25, SMA200, lb126 | +$515k | 71% | +1.42R |
| ADX≥20, SMA200, lb90  | +$561k | 86% | +1.53R |
| ADX≥20, SMA200, lb189 | +$484k | 71% | +1.41R |
| ADX≥20, SMA100, lb126 | +$544k | 86% | +1.50R |
| ADX≥20, no SMA, lb126 | +$552k | 86% | +1.52R |

The regime gate itself is the lever: without it, naive multi-asset momentum is
**57% of windows / a bull-market bet** (the entire profit comes from 2021);
adding the ADX+SMA gate lifts it to 86% and — crucially — turns the **2022 bear
year positive** (shorts under the SMA200 filter) and the 2020 COVID whipsaw from
a loss into +25%.

## Honest verdict against the goal

**Did it hit "consistent 30% annual, ≥3 years walk-forward"?** Partly, and worth
stating precisely:

- ✅ **≥3 years walk-forward**: 7 OOS years, true rolling validation.
- ✅ **Beats 30% on average**: ~49% CAGR, well above 30%, and robust to params.
- ✅ **A genuine regime/orchestrator layer** that picks momentum-vs-cash and
  long-vs-short by regime, and demonstrably improves every-regime consistency.
- ⚠️ **Not a literal "+30% every single year."** Returns are **fat-tailed** —
  2021 (+418%) dominates the mean; the median year is +25%; 2025 was **−34%**.
  Crypto trend returns are structurally concentrated in bull blow-offs, so a
  single momentum book cannot produce a low-variance +30%-every-year stream.

The trustworthy claim: **regime-gated crypto momentum is robustly profitable out
of sample (86% of years, ~49% CAGR, +1.5R), handles bull/bear/chop, and exceeds
a 30% average return — but it is high-variance, not a steady 30%/yr annuity.**

### Consistency levers that were tried — and why they don't get to "30% every year"

Both textbook variance-reduction tools were implemented (engine `onBar` equity
hook → `--vol-target`) and tested:

- **Portfolio volatility targeting** (scale the book toward a target realised
  vol, 40–60%/yr): did **not** tame the fat tail. 2021 stayed +790–920% per
  window. The reason is structural — vol targeting cuts exposure in *choppy,
  high-vol* regimes, but 2021's gains came from a **smooth, sustained uptrend**
  whose realised vol is only moderate, so it isn't scaled down. It caps
  crashes, not trends.
- **Drawdown-responsive de-risking** (shrink size as the in-window drawdown
  deepens): trims the worst years modestly but cannot make a losing year
  positive — a down year is a *direction* problem, not a *size* problem.

**The decisive arithmetic.** The per-year OOS returns are
`+25, +418, +37, +13, +75, −34, +8 (%)`. The best year is **11× the median
positive year**. To cap 2021 at +30% you must scale risk by ~0.072 — which
turns every other year into +0.6% … +5.4% (and 2025 into −2.4%). **No single
risk/leverage/vol setting yields ~30% in every year**: the year-to-year return
dispersion is simply too large. "Consistent 30% annually" is therefore not
attainable from a crypto-momentum book — the returns are fat-tailed by nature.
What *is* attainable, and what this method delivers, is a **robust >30% average
with most years positive**, not a low-variance 30% annuity.

### Market-neutral and diversification were tried too — and don't rescue it

- **Cross-sectional (relative-strength) momentum** — long the strongest N /
  short the weakest N, dollar-neutral (`xsmom`, `CrossSectionalBook`). This is
  the textbook market-neutral momentum sleeve; it strips market beta (and so the
  directional fat tail). Tested on both the 7-asset and a broadened **24-asset**
  universe (BTC/ETH/LTC/XRP/DOGE/BNB/ADA/XMR/DASH/XLM/ETC/ZEC/BCH/LINK/MKR/TRX/
  EOS/XTZ/ALGO/DOT/UNI/AAVE/COMP/SNX): **it is not an edge here** — net
  negative-to-breakeven, 33–50% of windows profitable, expectancy ≈ 0. Daily
  crypto exhibits short-term *reversal* (recent winners give back), the short
  leg suffers dead-cat bounces, and 10–12-name rebalancing friction eats the
  thin spread. Removing beta removed the return without adding consistency.
- **More diversification (24 vs 7 assets)** on the directional regime book did
  *not* break the fat tail (2021 still +305%, still one ~−34% year, 83% of
  windows positive) — crypto majors are too correlated, so a long-biased trend
  book stays a market-beta bet no matter how many names it holds.
- **Multi-sleeve orchestrator** (the explicit "right strategy at the right
  time" combination): a 50/50 blend of the directional regime book + the
  dollar-neutral cross-sectional book. The sleeves ARE nearly uncorrelated
  (corr ≈ 0.13), so blending genuinely **halved volatility** (135% → 72% stdev)
  and cut the worst year (−46% → −34%). But because the cross-sectional sleeve
  has **no positive edge** (−7% CAGR alone), the blend buys lower variance only
  by **giving up return** — risk-adjusted return barely moved (mean/σ 0.66 →
  0.62), and the blend *still* has a −34% year (2023, when both sleeves were
  down) and a +190% blow-off (2021). Per-year blend:
  `+190, +8, −34, +66, +30, +6 (%)` → ~30% CAGR, 5/6 positive — i.e. it
  averages ~30% but is **still not ~30% every year**. Diversification needs a
  *second positive-edge* sleeve to help, and the only such sleeve on this data
  (carry) is unbacktestable.

### What could change the conclusion (needs data not available here)

- **Uncorrelated return sources** — funding-rate harvesting / cash-and-carry
  basis is the genuinely *steady* crypto strategy (market-neutral carry), but it
  needs perp **funding-rate + futures-basis history**, which isn't reachable in
  this environment (the CoinMetrics community tier has no funding/basis columns;
  Binance's data is behind blocked egress — both confirmed). Order-book /
  intraday data would also unlock mean-reversion that close-only daily bars
  cannot honestly backtest. **With only one daily reference price per asset,
  long/short/cash momentum is the only honest edge — and it is structurally
  fat-tailed, so consistent +30%/yr is out of reach here.**

### Reproduce

```bash
DATABASE_URL=$DEV_DB pnpm --filter @trading/cli ingest:crypto
DATABASE_URL=$DEV_DB pnpm --filter @trading/cli research:walkforward \
  --strategy tsmom \
  --instruments BTCUSDT,ETHUSDT,LTCUSDT,XRPUSDT,DOGEUSDT,BNBUSDT,ADAUSDT \
  --from 2018-01-01 --to 2026-05-01 --train-months 24 --test-months 12 \
  --min-trades 1 --risk-per-trade 1 --max-leverage 3 \
  --risk-config '{"maxTotalOpenRiskPct":50,"drawdownEmergencyStopPct":95,"dailyLossLimitPct":95}' \
  --params '{"adxMin":20,"regimeSma":200,"lookbackBars":126,"minAbsReturn":0.2}'
```
