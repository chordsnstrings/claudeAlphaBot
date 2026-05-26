# Can any variables push BTC/ETH prediction to 80%? — measured

Goal: find variables that improve prediction accuracy to 80%. Tested over 2022→2026,
walk-forward OOS (monthly retrain, causal, no leakage). Code:
[`research/pattern_features.py`](research/pattern_features.py).

## Verdict: No — not for any *honest, balanced, tradeable* target.
80% accuracy appears only as one of two artifacts: **base-rate from imbalanced targets**
(predicting "quiet day", usually right but useless) or **overfitting** (high in-sample,
coin-flip out-of-sample). No variable set — price, volatility, volume, momentum,
cross-asset, or the external feeds we can't access — moves balanced direction accuracy
above ~53%.

## 1. DIRECTION (next-day up/down) — variables don't help
| Feature set | BTC OOS acc | ETH OOS acc |
|---|--:|--:|
| momentum only | 50.8% | 49.8% |
| + volatility | 50.8% | 50.1% |
| + RSI / MA / acceleration | 50.1% | 49.4% |
| + volume | 49.2% | 52.4% |
| + cross-asset (BTC→ETH) | — | 52.6% |

Every addition leaves direction at **~50–53%** — a coin-flip. Volatility, volume, RSI,
moving-average distance, and cross-asset lead-lag add essentially nothing to *direction*.
There is no variable here that approaches 80%.

## 2. The base-rate trap — why "82%" is not prediction
The one target that *scored* ~80% was "will tomorrow move >3%?" — **but that is class
imbalance, not skill:**
| Coin | P(big >3% day) | "always predict quiet" accuracy | model accuracy | real skill |
|---|--:|--:|--:|--:|
| BTC | 18.2% | **81.8%** | 81.9% | **~0%** |
| ETH | 28.7% | 71.3% | 70.8% | **negative** |

The model just learned "most days are quiet," which is right 82% of the time for BTC and
**adds no predictive value**. Any "80% accurate" claim on an imbalanced target is this
illusion. (On the *balanced* version — "vol above its median", base rate 50% — accuracy is
only **53–55%**, which is the genuine-but-modest volatility-clustering edge.)

## 3. The overfitting trap — how 80% is faked in-sample
| Coin | features | IN-SAMPLE acc | OUT-OF-SAMPLE acc |
|---|--:|--:|--:|
| BTC | 19, no regularisation, 300-day train | 62.3% | **51.0%** |
| ETH | 21, no regularisation | 65.7% | **51.0%** |

With more features / less data you can drive in-sample accuracy past 80% — and it still
collapses to a coin-flip OOS. **That is what an "80% direction model" actually is:**
memorised noise. The IS→OOS gap *is* the answer to the goal — the variables that "raise"
accuracy to 80% are the ones that overfit.

## 4. External variables (the honest catalog — what they could add, and the ceiling)
These are the genuinely informative variables not in price data. None reach 80% on
direction; realistic lift is a few percent, and most are **unavailable in this environment**.
| Variable | Predicts | Realistic direction lift | Available here? |
|---|---|--:|:--:|
| Funding rate / open interest / long-short ratio (positioning) | contrarian direction | +2–4% (→ ~55%) | ❌ blocked |
| Options 25Δ skew / implied vol | volatility, mild direction | helps *vol* target | ❌ Deribit blocked |
| On-chain (exchange flows, stablecoin supply, MVRV) | slow direction/regime | +2–4% | ❌ paid API |
| Macro (DXY, real rates, SPX/VIX, liquidity) | risk regime | +2–4% | ❌ |
| Order-flow / L2 microstructure | seconds-ahead | n/a (needs tick data) | ❌ |
| Cross-asset lead-lag (BTC→alts) | direction | +0.2–0.8% (tested) | ✅ marginal |

Stacked optimistically, these might lift balanced direction accuracy from ~52% to perhaps
**~55–58%** — valuable for a strategy, but an order of magnitude short of 80%.

## 5. Why 80% on direction cannot exist
A model that called next-day BTC/ETH direction 80% of the time would be the most
profitable discovery in finance; capital would pour into it and arbitrage the edge back to
~50%. Persistent 80% directional accuracy is therefore self-contradictory in a liquid
market. The only things that *are* ~80%+ predictable are **persistent states** (is the
market currently calm or wild, in an up- or down-regime) — and "predicting" a persistent
state is mostly restating the present, not forecasting the future move.

## Bottom line
- **No variable gets balanced/tradeable BTC/ETH prediction to 80%.** Direction sits at
  ~50–53%; the real volatility edge is ~53–55%.
- **Apparent 80%** = base-rate of an imbalanced target (useless) or overfitting (fake OOS).
- The honest improvements available (positioning, on-chain, macro — mostly not reachable
  here) add a few percent at best, lifting direction to maybe ~55–58%.
- This is the deepest confirmation of every prior result: the edge in BTC/ETH is **weak,
  statistical, and harvested at scale via sizing + diversification + risk control** — not
  an 80% crystal ball. Chasing 80% directional accuracy is chasing an artifact.

## Appendix — additional reachable variables tested (breadth, dominance, intraday)
To exhaust the *reachable* variable space beyond price/momentum/vol/volume/cross-asset,
also tested (walk-forward OOS, next-day direction, 2022→2026):
- **Market breadth** (% of the 55-coin universe above its 50d MA) + 5-day change
- **BTC dominance / relative-strength trend** (BTC vs equal-weight alts, 20d)
- **Intraday microstructure** (daily range, last-6h momentum into the close, overnight gap)

| Feature set | BTC OOS dir acc | ETH OOS dir acc |
|---|--:|--:|
| base (mom20, vol20) | 50.1% | 49.0% |
| + breadth / dominance | 50.6% | 49.6% |
| + intraday (range, last-6h, gap) | 49.3% | 49.2% |
| + ALL new variables | 51.0% | 49.6% |

None move direction above ~51%. **The reachable variable space is now exhausted** — no
price-derived, cross-asset, breadth, dominance, or intraday-microstructure variable lifts
next-day BTC/ETH direction prediction beyond noise. The only untested variables are the
blocked external feeds (funding/OI/options-skew/on-chain/macro), which the evidence and
literature put at a ~55–58% ceiling — still far from 80%. **Conclusion stands: no variable,
reachable or otherwise, honestly reaches 80% on balanced direction.**
