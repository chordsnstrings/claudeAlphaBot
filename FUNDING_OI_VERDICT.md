# Does funding / open interest / positioning lift BTC-ETH prediction? — measured

The prediction study ([`PREDICTION_TO_80_BTC_ETH.md`](PREDICTION_TO_80_BTC_ETH.md)) found
next-day direction is a coin-flip (~50–53%) on every *reachable* variable, and flagged
**positioning data — funding rate, open interest, long/short ratios** — as the single
informative external lever it could not fetch (live `fapi.binance.com` is geo-blocked,
HTTP 451). The literature/optimistic expectation was *+2–4% → ~55%*.

`data.binance.vision` (the static futures-dump bucket) is now reachable, so this lever was
fetched and tested with the **same walk-forward rigor** (causal features, monthly-retrained
logistic, scored OOS vs the always-up/down base rate). Code:
[`research/funding_oi_predict.py`](research/funding_oi_predict.py); loader:
[`research/binance_vision_futures.py`](research/binance_vision_futures.py).

## Verdict: No. The last untested lever adds nothing significant to direction.
Funding/OI/long-short leave next-day **direction at ~50–51%** — within one standard error
of both the price-only baseline and the base rate. The best single result (+1.3% from
funding on the full 2020→2026 window) is **~1σ — noise**. The data delivers *less* than the
optimistic +2–4%, and is an order of magnitude short of 80%. Its only mild, theory-consistent
value is on **volatility** (positioning extremes precede vol, not direction), and even that
is ~+0.5–0.9% over a price-only vol model — within noise. **This closes the last open
question: no reachable variable, now including positioning, gives a real directional edge.**

## Data now reachable (no API key, no geo block)
| Feed | Coverage fetched | Granularity | Notes |
|---|---|---|---|
| Funding rate | 2020-01 → 2026-04 (complete) | 3 settlements/day @ 8h | aggregated to daily sum/mean |
| Metrics: OI, OI-value, global & top-trader L/S, taker buy/sell | 2021/2023 → 2026-05 | 5-min snapshots → end-of-day | **large gaps through 2022** (Binance's dumps lack most of 2022); clean from ~2023-01 |

All features align to the spot `date` whose close is end-of-day-D; funding settles ≤16:00
UTC and the metrics snapshot is ~23:55 UTC, so both are known at `close[D]` — **no look-ahead**.

## 1. Next-day DIRECTION — controlled ablation (identical rows, differ only in features)
Because OI has 2022 gaps, every set is trained and tested on the **same rows** (all features
non-NaN), so any delta is the feature effect, not a sample-size artifact. `d_base` = lift
over the price baseline on those rows.

**BTC (h=1d, n=1199, base 50.7%)** — standard error ≈ **±1.44%**
| Feature set | OOS acc | edge vs base | d_base |
|---|--:|--:|--:|
| price baseline | 50.9% | +0.2% | — |
| + funding | 49.4% | −1.3% | −1.5% |
| + OI / positioning | 51.0% | +0.3% | +0.2% |
| + funding + OI | 49.0% | −1.7% | −1.8% |
| funding only | 48.1% | −2.6% | −2.8% |
| OI / positioning only | 49.5% | −1.2% | −1.3% |

**ETH (h=1d, n=882, base 50.8%)** — standard error ≈ **±1.68%**
| Feature set | OOS acc | edge vs base | d_base |
|---|--:|--:|--:|
| price baseline | 50.6% | −0.2% | — |
| + funding | 49.7% | −1.1% | −0.9% |
| + OI / positioning | 50.1% | −0.7% | −0.5% |
| + funding + OI | 48.9% | −1.9% | −1.7% |
| OI / positioning only | 50.7% | −0.1% | +0.1% |

Every funding/OI addition lands within ±1σ of the baseline — **no edge**. At h=5d both coins
sit *below* the always-up base rate for all sets (a few `d_base` positives appear only because
the price baseline is itself poor at h=5; absolute accuracy still loses to the base rate).

## 2. Funding on its FULL window (2020→2026, no OI-gap restriction)
Funding has no gaps, so it gets the longest possible test:
| | price | price + funding | Δ | base | n |
|---|--:|--:|--:|--:|--:|
| BTC h=1d | 50.0% | **51.3%** | +1.3% | 50.2% | 1430 |
| BTC h=5d | 49.9% | 50.2% | +0.3% | 53.3% | 1430 |
| ETH h=1d | 50.9% | 51.2% | +0.3% | 50.1% | 1430 |
| ETH h=5d | 53.7% | 51.9% | −1.8% | 51.3% | 1430 |

BTC's +1.3% is the best directional result in the whole study — and at n=1430 the standard
error is ±1.32%, so it is **≈1σ, indistinguishable from noise**, and it does not replicate on
ETH or at h=5d.

## 3. Direct positioning signals (no ML — the economic hypotheses, OOS 2022→)
Causal z-score rules; "dir-hit" = next-day direction hit rate, plus average **signed** next-day return.
| Signal | BTC hit / signed-ret | ETH hit / signed-ret |
|---|--:|--:|
| Fade high funding (contrarian) | 48.5% / +0.03% | 51.7% / −0.01% |
| Fade extreme global long/short | 49.5% / +0.14% | 47.9% / −0.06% |
| OI-confirmed 5d momentum | 46.8% / +0.03% | 46.3% / −0.01% |
| Raw funding sign (carry persistence) | 50.8% / +0.06% | 49.3% / +0.03% |

Hit rates 46–52%, signed next-day returns within a few bps and mixed in sign across coins.
**No tradeable contrarian-funding, long/short-fade, or OI-confirmation edge** survives OOS.

## 4. VOLATILITY target — where positioning *should* help (and barely does)
Target: next-day |return| above its trailing-20d median (balanced). `d_base` = lift over the
price-only vol model.
| Feature set | BTC OOS | ETH OOS |
|---|--:|--:|
| price-vol baseline | 50.6% | 53.2% |
| + funding | 50.4% (−0.3) | **54.1% (+0.9)** |
| + OI | 51.5% (+0.8) | 53.6% (+0.5) |
| + funding + OI | 52.0% (+1.3) | 52.7% (−0.5) |

The vol predictability (~53–54% for ETH) is the **known price-derived vol-clustering edge**;
funding/OI add only ~+0.5–0.9% on top — within the ±1.4–1.7% standard error. Consistent with
theory (positioning extremes precede *volatility*, not *direction*), but not a material gain.

## 5. Statistical reality
At these sample sizes the standard error of an OOS accuracy estimate is **±1.3% (n≈1430)** to
**±1.7% (n≈880)**. A genuine 95%-significant edge would need roughly **+2.6–3.4% over the base
rate**. Nothing in the direction tests clears that bar; the largest direction lift is ~1σ and
does not replicate across coin/horizon. The result is robust to inf-cleaning and to the
controlled-rows design.

## Bottom line
- **Funding / OI / long-short do not lift next-day BTC/ETH direction** beyond ~51% — no
  statistically significant edge over the price baseline or the base rate.
- The previously-hoped *+2–4% → ~55%* **did not materialize**; measured direction lift is ≈0.
- Positioning adds at most a small, theory-consistent (~+0.5–0.9%, non-significant) bump to
  **volatility** classification — the already-predictable target driven mostly by price.
- **The reachable variable space is now fully exhausted**, including the last external lever.
  Every prior conclusion stands: BTC/ETH direction is weak/statistical (~50–53%), "80%" is a
  base-rate or overfitting artifact, and the edge is harvested via sizing, diversification,
  and risk control — not directional forecasting.
