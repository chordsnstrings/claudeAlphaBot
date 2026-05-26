# Can we accurately predict BTC/ETH over the last 4 years? — measured

Walk-forward, out-of-sample prediction accuracy for BTC & ETH over **2022-05 → 2026-05**.
A logistic model (causal features) is **retrained every month on strictly-past data** and
scored on the unseen month; volatility is tested with a persistence (clustering) forecast.
Code: [`research/pattern_predict.py`](research/pattern_predict.py).

## Verdict: No — direction is not accurately predictable; volatility only partially.

| Target (OOS, last 4 yrs) | BTC | ETH | Accurate? |
|---|---|---|:--:|
| **Direction, next 1 day** | 50.4% hit (base 50.2%) | 48.9% (base 49.8%) | ❌ coin-flip |
| **Direction, next 5 days** | 51.9% (base 53.1%) | 47.9% (base 50.9%) | ❌ below baseline |
| **Direction, next 20 days** | 50.3% (base 54.5%) | 51.5% (base 52.4%) | ❌ below baseline |
| **Volatility, h=1** corr(var, next ret²) | +0.09 | +0.11 | ❌ weak |
| **Volatility, h=5** corr | +0.22 | +0.24 | ⚠️ partial |
| **Volatility, h=20** corr | +0.18 | +0.29 | ⚠️ partial (R²<0) |

"base" = the better of always-up / always-down. **The model does not beat the naive
baseline at any horizon for either coin** — i.e. you would have done as well or better by
just assuming the prevailing drift, with no model at all.

## What this means
- **Direction is unpredictable over this window.** Next-day, next-week, and next-month
  up/down all land at ~48–52% — statistically a coin-flip, and *below* the always-up/down
  baseline at the medium horizons. There is no accurate directional prediction here.
- **Volatility is only partially predictable.** The persistence (clustering) forecast has
  a positive but **modest** correlation (~0.2–0.3 at 5–20 days) and a **negative R²** at
  h=20 — meaning it gets the *shape* slightly right but mis-levels the *magnitude* because
  the vol regime shifted (high in 2022, lower 2023–24, up again 2025). Even the "robust"
  pattern is weak when you demand accurate forward prediction in a specific recent window.

## Why this is *more* honest than the pattern study (and reconciles with it)
The earlier `PATTERNS_BTC_ETH.md` found, on **30+ years of pooled history**, that momentum
(53–55% continuation) and volatility clustering (autocorr 0.20) are real. Both are true —
*as long-run averages*. But this test asks the harder, fairer question: **retrain monthly
and predict the next unseen month over the last 4 years.** Under that standard:
- The momentum continuation **does not survive** — the 2022–2026 window (bear → recovery →
  chop → selloff) was regime-shifting, which is exactly the environment that breaks trend
  persistence, so the full-history edge washed out OOS.
- Volatility clustering survives only **partially** — the signal is there (positive corr)
  but too weak/regime-dependent to forecast magnitude accurately 20 days out.

In-sample pattern detection finds structure; **out-of-sample walk-forward prediction
humbles it.** That gap is the single most important thing this exercise shows.

## Implications (ties the whole project together)
1. **You cannot accurately predict BTC/ETH direction** — which is the deepest reason every
   high-leverage / day-trading / "20–30% monthly" goal failed: they all need accurate
   short-term direction, and it isn't there.
2. **The validated strategy never relied on accurate prediction.** Momentum + inverse-vol
   sizing works *not* by predicting each move, but by taking many small, diversified,
   risk-managed bets that win slightly more than half over long horizons and across
   assets, while volatility-targeting exploits the *partial* vol-predictability for sizing
   (not for timing). It is a weak edge harvested at scale — not a forecast.
3. **"Accurate prediction" is the wrong objective.** The achievable edge is statistical and
   slow; anything that claims accurate point-prediction of BTC/ETH (especially short-term
   direction) over the last 4 years is, by this measurement, not real.

## Caveats
- A single 4-year window is regime-specific; over longer/other windows momentum prediction
  scores better (the pattern study). But "the last 4 years" is exactly what the goal asked,
  and the answer for that window is: direction unpredictable, volatility partially so.
- Simple, transparent models are used deliberately (a complex model that "beats" this is
  almost always overfit; the honest baseline is what matters).
- This measures *prediction accuracy*, not strategy P&L — the validated engines still earn
  via diversification + sizing + risk control despite low point-prediction accuracy.
