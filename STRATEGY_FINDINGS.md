# BTCUSDT Strategy Study — 20%/Month Target with Monthly Profit Withdrawal

**Goal studied:** find the best bot strategy for BTCUSDT targeting **20% month‑on‑month**,
with **all profit above the base withdrawn every month** (constant working capital).

**Method:** real BTCUSDT 1‑hour candles (Binance public mirror
`data-api.binance.vision`), 2024‑11‑01 → 2026‑05‑24 (13,680 bars ≈ 18.5 months),
replayed through the existing deterministic backtest engine
(`runReplay`) with slippage + taker fees. Each strategy was run at three
risk‑per‑trade levels in two accounting modes:

- **COMPOUND** — profit stays in the account (context / upper bound).
- **SKIM** — at each UTC month boundary every dollar above the $10,000 base is
  withdrawn, so position sizing stays anchored to the base. This is the
  "take the extra out each month" rule, implemented in
  `backtest/withdrawal.ts` + `runReplay`.

Reproduce: `pnpm --filter @hydra/bot fetch-btc-data` then
`pnpm --filter @hydra/bot analyze-btcusdt`
(raw numbers in `artifacts/btcusdt_strategy_analysis.json`).

---

## Headline answer

**No strategy reaches 20% per month.** Across 19 calendar months not one
configuration cleared +20% in more than a single month, and most are net
negative on constant capital. 20%/month (≈ **791% per year compounded**, or
**240%/yr** even with the profit skimmed off) is far outside what these — or any
legitimate systematic BTC strategy — produce. Any product promising it is
selling survivorship bias or a blow‑up waiting to happen.

**Best realistic strategy: `WEEKEND_MR` (weekend mean‑reversion).** It is the
only strategy that is profitable and has a positive, stable risk‑adjusted
profile on real data.

| Strategy @ risk | Trades | Win% | Median mo. | Mean mo. | Best mo. | Worst mo. | Months ≥20% | Compound APR | Max DD (compound) | Sharpe |
|---|---|---|---|---|---|---|---|---|---|---|
| **WEEKEND_MR @ 2%** | 9 | 67 | 0.0% | **+1.24%** | 12.5% | −2.2% | 0/19 | 15.4% | **5.7%** | **1.52** |
| **WEEKEND_MR @ 5%** | 9 | 67 | 0.0% | **+1.62%** | 20.6% | −5.3% | 1/19 | 19.5% | 11.7% | 1.19 |
| ARB @ 5% | 50 | 48 | 0.0% | −0.65% | 14.4% | −14.8% | 0/19 | −9.9% | 23.3% | −0.44 |
| NY_OPEN @ 2% | 230 | 43 | −4.1% | −1.79% | 16.3% | −13.2% | 0/19 | −22.4% | 53.1% | −1.02 |
| Portfolio (ARB+NY+WMR) @ 2% | 268 | 44 | −2.3% | −0.62% | 11.3% | −11.2% | 0/19 | −10.4% | 42.4% | — |

Over the full window, WEEKEND_MR @ 5% withdrew **$2,965 on a $10,000 base
(~30%, ≈ 1.6%/month average)** while keeping working capital constant.

## Good-faith optimization & the ceiling

I didn't stop at defaults. `optimize-btcusdt.ts` sweeps WEEKEND_MR
(threshold × stop buffer × risk = 36 configs) plus ARB/NY grids, scored on
constant‑capital monthly return, then runs a risk ladder, a buy‑and‑hold
benchmark, and a train/out‑of‑sample split. Reproduce with
`pnpm --filter @hydra/bot optimize-btcusdt`
(`artifacts/btcusdt_optimization.json`).

**Best config found:** `WEEKEND_MR threshold=3.0, stop=0.3·ATR @ 5% risk` —
**1.71%/month** mean, 1/19 months ≥20%, 20.8% compound APR, 24% constant‑capital
drawdown. Marginally better than the default; nowhere near 20%.

**You cannot buy 20%/month with leverage.** The risk ladder on that config:

| Risk/trade | Mean month | Constant‑cap max DD | Note |
|---|---|---|---|
| 2% | +1.43% | 16.0% | survivable |
| **5%** | **+1.71%** | 24.3% | **peak** |
| 10% | +1.11% | 25.8% | already decaying |
| 20% | −0.11% | — | losers dominate |
| 40–80% | 0.00% | — | account wiped, then idle |

Return **peaks near 5% risk and falls apart above it** — bigger size means bigger
losers and sizing rejections, not more profit. There is no risk setting that
turns this edge into 20%/month; pushing toward it destroys the account.

**On leverage — yes, it's used, and it's capped.** Sizing is risk‑based: WEEKEND_MR's
stops sit ~1.2% from entry on average, so even 2% risk produces **~1.7× notional
exposure** (≈1.7× leverage); the recommended config is *not* unleveraged. The
engine hard‑caps total exposure at **2.5× equity**, and from ~5% risk upward
sizing simply pins to that ceiling — which is why the ladder above flattens then
decays (trade count collapses 9 → 7 → 3 as oversized orders get rejected). The
per‑symbol leverage parameter defaults to 20× but only governs posted margin,
not P&L. Bottom line: **even at the maximum 2.5× exposure the system allows, the
best result is ~1.7%/month** — 20%/month is not reachable by adding leverage, and
lifting the cap only converts an ordinary losing streak into account death.

**The asset itself doesn't offer it.** BTC buy‑and‑hold over this window returned
**+9.8% total** (mean +1.24%/month) and rose **≥20% in only 1 of 19 months**.
With profit withdrawn each month (no compounding), 20%/month requires generating
20% of base in fresh profit *every* month — but the underlying barely delivers a
20% month even once. That is the hard ceiling, independent of strategy.

**Out‑of‑sample, it holds up (modestly).** 70/30 train/OOS split: TRAIN
+1.90%/month → OOS **+0.96%/month**, 0/6 OOS months ≥20%. Positive and not a
catastrophic overfit — but a realistic ~1%/month, not 20%.

---

## Why WEEKEND_MR wins (and why it still isn't 20%/month)

It fades outsized weekend moves at the Monday open — a real, documented
microstructure edge — and trades **rarely** (≈ 9 trades in 18 months), so it
sidesteps the fee/whipsaw drag that sinks the intraday breakout strategies
(ARB, NY_OPEN) in this chop‑heavy, mostly‑sideways BTC regime.

The flip side is exactly why 20%/month is impossible here: it is **flat in most
months** because no qualifying setup appears. Its monthly path:

```
2024-11 -5.1   2025-03 +20.6   2025-07  0.0   2025-11  0.0   2026-03  0.0
2024-12 -3.4   2025-04  -5.3   2025-08  0.0   2025-12  0.0   2026-04 +5.8
2025-01 +7.1   2025-05  +5.6   2025-09  0.0   2026-01  0.0   2026-05  0.0
2025-02  0.0   2025-06   0.0   2025-10 +5.5   2026-02  0.0
```

One +20.6% month, several mid‑single‑digit winners, the rest idle or small
losers. A "20% every month" mandate requires a setup that prints every month;
this one structurally cannot.

The breakout strategies *can* spike to +14–16% in a good month but give it all
back: NY_OPEN at 2% risk lost 22%/yr with a 53% drawdown. Pushing risk to chase
20%/month makes the drawdowns — not the returns — the thing that compounds.

---

## What "20%/month with monthly withdrawal" actually implies

The withdrawal rule is the *one genuinely good idea* in the goal, and it is now
implemented and tested. Skimming profit to base each month means you **cannot
compound**, so to realize 20%/month you must generate 20% of base in *new*
profit every single month — there is no good month carrying a bad one. On real
BTC data the best strategy did that once in 19 tries. To force the average up
to 20% you would have to raise risk‑per‑trade to a level where a normal losing
streak (which WEEKEND_MR has — three negative months in a row to start the
window) wipes the account before the withdrawals ever accumulate.

**Recommendation:** treat **15–20% *per year*** with single‑digit drawdowns as
the achievable target. The soundest deployable config is **`WEEKEND_MR`
threshold=3.0 @ 2% risk** (Sharpe 1.52, ~6% max DD, ~15–18%/yr); 5% risk lifts
the mean to ~1.7%/month but doubles the drawdown for little gain, and anything
beyond that decays. Keep the **monthly profit skim** on top of it — it is the
correct risk discipline and the one part of the original goal worth keeping as
stated. Reframe the objective from "20%/month" to "consistently skim a
positive‑expectancy edge each month," and this bot can serve it. The literal
20%/month is not a strategy problem — it exceeds what BTC itself offered in 18
of the last 19 months — so it should be dropped rather than chased.

---

## Limitations (read before trusting the numbers)

- **Spot proxy.** `fapi.binance.com` is geo‑blocked from this environment, so
  spot OHLCV was used as a stand‑in for the perp. Prices track within a few bps;
  perp **funding costs are not modelled**, so live perp returns would be slightly
  *lower*.
- **FUNDING_FADE not tested.** It needs perp funding‑rate history, unavailable
  here. BB_MR is listed in the spec but has **no signal generator** in the code.
- **One regime, ~18 months.** Results are a single (choppy/sideways) BTC regime,
  not a multi‑cycle validation. Run the project's full
  `validate-pipeline` (walk‑forward + Monte Carlo + OOS) before any capital.
- **Default fees, no execution latency or partial‑fill realism** beyond the
  engine's slippage model.
