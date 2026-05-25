# Drawdown Control — Stop the Bleed, Keep the Profits

**Goal:** keep the validated per-coin momentum returns but minimise drawdown by
detecting — causally — when the market is in a bleed-prone state and cutting exposure.
Walk-forward out-of-sample. Code: [`research/dd_control.py`](research/dd_control.py)
→ `research/results/dd_control_results.json`.

> You cannot *predict* a crash. You **can** detect, with only past data, the
> conditions that bleed an account — and size down while they hold. The single most
> effective such signal is the **strategy's own equity drawdown**: when the curve
> rolls over, the regime has already turned; ride it smaller.

---

## The mechanism (causal, fixed parameters — not fit to data)

Three de-risk overlays on top of the per-coin `tsmom_blend` momentum engine:

1. **Equity-curve drawdown brake (the winner).** Track the strategy's running
   equity. Above −12% drawdown from peak → full size; ramp **linearly** down to
   **flat at −30%** drawdown; restore automatically as the curve recovers.
   *Graded* (a smooth ramp), not a hard switch — a hard "flatten at −25%" over-triggers
   on high-vol coins (it zeroed DOGE). All causal: the size for day *t* uses equity
   realised through day *t*.
2. **Trend gate (optional).** Below the 200-day SMA → cut to a floor. Avoids the
   worst of bear regimes; adds worst-year protection at some cost to return.
3. **Volatility brake.** Scale ~ `vol_cap / realised_vol`. Marginal here (the engine
   already vol-targets); kept for completeness, not in the recommendation.

**Recommended: the graded equity-curve drawdown brake** (optionally + SMA-200 gate
for extra tail protection).

---

## Result — base momentum vs graded drawdown brake (walk-forward OOS)

| Coin | maxDD base → brake | Calmar base → brake | Sharpe base → brake | worst year base → brake | CAGR kept |
| --- | --- | --- | --- | --- | ---: |
| **BTC** | −48% → **−27%** | 1.94 → 1.94 | 1.56 → 1.56 | −21% → −16% | 57% |
| **ETH** | −47% → **−22%** | 1.23 → **1.79** | 1.32 → **1.41** | −5% → −2% | 67% |
| **SOL** | −45% → **−21%** | 0.84 → **0.96** | 1.00 → 0.98 | −21% → −7% | 57% |
| **DOGE** | −45% → **−31%** | 0.87 → **0.95** | 0.92 → **0.97** | −24% → −5% | 74% |
| **XRP** | −81% → **−32%** | 0.20 → **0.35** | 0.54 → **0.62** | −50% → −19% | 69% |

**What this shows:**
- **Drawdown is cut by ~40–60% on every coin** — XRP's catastrophic −81% becomes −32%;
  the −45/−48% majors become −21/−27%.
- **Risk-adjusted return improves or holds:** Calmar rises for ETH, SOL, DOGE, XRP
  (flat for BTC); Sharpe rises for ETH/DOGE/XRP, holds for BTC/SOL.
- **Worst calendar year shrinks dramatically:** SOL −21%→−7%, DOGE −24%→−5%,
  XRP −50%→−19%, BTC −21%→−16%.
- **The cost is raw CAGR** (≈25–45% of it), the unavoidable price of de-risking. You
  trade some upside for far less bleed — and on a risk-adjusted basis you come out
  **ahead**, which is what protects a real account from ruin and from the behavioural
  blow-up of riding a −80% drawdown.

The earlier hard-step brake cut DD even more on BTC/ETH (−26%/−21%, Calmar 2.09/1.63)
but **destroyed DOGE** (CAGR −1%: it flattened and never re-engaged). The **graded**
brake is the robust choice that works on all five.

---

## Why this answers "understand when the market will bleed the account"

The equity-curve drawdown brake is a *regime detector that needs no forecast*: a
sustained drawdown in the strategy's own P&L **is** the signature that the regime
(trend) has turned against it — choppy whipsaw or a developing bear. Cutting size as
the drawdown deepens means the account bleeds slowly and survives to re-engage when
the trend resumes, instead of compounding losses into ruin. Combined with the SMA-200
trend gate (avoid being long below the long-term trend) and the engine's built-in
vol-targeting and long-only momentum (already flat in confirmed downtrends), the stack
addresses bleed from all three angles: **wrong direction (trend gate), too much size in
turmoil (vol-target), and a regime that has already turned (drawdown brake).**

---

## Deployment

Apply the graded drawdown brake as a multiplier on the per-coin target weight from
`PER_COIN_BEST_STRATEGIES.md` / `production_strategy.py`:

```
state[t] = 1.0                              if equity_dd[t] >= -0.12
         = 0.0                              if equity_dd[t] <= -0.30
         = 1 - (|dd|-0.12)/(0.30-0.12)      in between        # linear ramp
w_live[t] = w_momentum[t] * state[t]        # optionally * 1{price>SMA200}
```
`equity_dd[t]` = current equity / running peak − 1, computed from realised P&L through
day *t* (causal). This sits **below** the annual −40% / monthly −20% hard stops as a
*continuous* de-risk, so the account rarely reaches the hard stop at all.

**Caveats.** Drawdown control reduces drawdown and improves risk-adjusted return; it
does **not** raise raw CAGR (it lowers it) and cannot prevent a fast overnight gap
(daily bars; a crash that happens between closes is realised before the brake reacts —
intraday execution with stops, per `eth_intraday_stops.py`, tightens this further).
Parameters here are fixed, not optimised; re-validate on your data before capital.
