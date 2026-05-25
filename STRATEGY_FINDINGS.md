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

**Recommendation:** treat 15–20% *per year* with single‑digit drawdowns as the
achievable target. WEEKEND_MR @ 2% risk (Sharpe 1.52, 5.7% max DD, +15%/yr) is
the soundest config; the monthly skim is the right risk discipline to keep on
top of it. Reframe the goal from "20%/month" to "consistent monthly skim of a
positive‑expectancy edge," and this bot can serve it.

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
