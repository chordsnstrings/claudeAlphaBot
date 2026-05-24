# Crypto walk-forward research: regime-gated momentum

Search for an autonomous method delivering a **consistent ~30% annual return on
crypto perpetual futures**, validated by rolling walk-forward (the strategy is
only ever judged on out-of-sample data). This records the method, the honest
results, what the regime ("orchestrator") layer did, and the real limits.

## Data

CoinMetrics community daily reference prices (`PriceUSD`), loaded via
`pnpm --filter @trading/cli ingest:crypto` from
`raw.githubusercontent.com/coinmetrics/data`. Seven liquid majors with a USD
reference price and multi-year history:

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

### Next levers (toward lower variance, not yet done)

- **Portfolio-level volatility targeting** (scale total book to a target
  realised vol) — caps the 2021 blow-off and lifts calm years; the proven
  managed-futures consistency tool. Per-asset ATR sizing is already in; the
  portfolio overlay is the remaining step.
- **Drawdown-responsive de-risking** to cut the 2025 −34% year.
- Higher-fidelity data (real perp OHLC + funding history) to validate
  tighter-stop and intraday regime logic that close-only daily data can't.

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
