# Predictable Patterns in BTC & ETH — rigorous findings

Statistics-first search for predictable structure in BTC (2014→2026) and ETH (2016→2026),
daily + 1h. Every candidate is judged by effect size, t-stat, **in-sample → out-of-sample
consistency**, and a multiple-testing lens (~34 hypotheses → ~1–2 false positives expected
by chance). Code: [`research/pattern_test.py`](research/pattern_test.py).

## Verdict
**Yes — but only two patterns are robust, and they are the two the validated strategy
already rests on.** Returns are *mostly unpredictable* at short horizons; the durable
structure is in **volatility** and **medium-term trend**, not in tomorrow's direction or
calendar effects.

| Pattern | BTC | ETH | Robust (signif + OOS + sensible)? |
|---|---|---|:--:|
| **Volatility clustering** (\|return\| autocorr) | 0.20 → 0.09 (lags 1–20), all sig | 0.23 → 0.07, all sig | ✅ **STRONG** |
| **Medium-term momentum** (20–60d continuation) | 53–54%, +4–13% L/S edge | 55%, +8–25% L/S edge | ✅ **real, modest** |
| Post-crash bounce (overreaction) | after −5% day: +0.72% next (t=2.1); −10%: +2.5% (t=2.3) | +0.96% (t=2.4); +2.8% (t=2.5) | ⚠️ real but risky to trade |
| Short-term (1-day) return | lag-1 autocorr −0.03; 48% continuation | −0.03; 47% | ❌ ~unpredictable |
| Day-of-week | Mon +0.44% (t=2.85, OOS-consistent) | Wed (OOS-consistent); Mon not | ❌ weak / inconsistent across assets |
| Month-of-year | best Oct, worst Sep | best May, worst Jun | ❌ noise (disagree across assets) |
| Hour-of-day (UTC) | 2 hours \|t\|>2 | 3 hours \|t\|>2 | ❌ noise (multiple testing) |

## The two real patterns

**1. Volatility is strongly predictable (clustering).** \|return\| autocorrelation is
0.20–0.23 at lag 1 and decays slowly but stays significant out to 20 days, for **both**
coins. This is the most robust finding by far. **Implication:** you can't predict *whether*
price goes up, but you *can* predict *how much it will move* — which is exactly why
**volatility-targeted position sizing works** (size up in calm, down in turmoil). The
validated engine's inverse-vol sizing harvests this directly.

**2. Medium-term momentum is real but modest.** At 20–60-day horizons, returns continue
their direction **53–55% of the time** (vs 50% random), with a long-minus-short forward
edge of +4% to +25%, and it holds in-sample → out-of-sample (ETH 20d: IS 56.7% / OOS
54.0%). At **1–5 days there is no edge** (≈48% continuation — slight reversion, not
tradeable after costs). **Implication:** trend-following on multi-week horizons has a
genuine edge; day-trading direction does not. This is precisely the `tsmom_blend` engine.

**3. Post-crash bounce — real but a knife-catch.** After a −5% day, the next day averages
+0.7–1.0% (vs +0.2% normally, t≈2.1–2.4); after −10%, +2.5–2.8% (t≈2.3–2.5), both coins.
Statistically real overreaction. **But** it's high-variance (you're buying a crash), the
sample is small (n=47–75 for −10% days), and it clusters in bear markets — tradeable only
with strict sizing/stops, not a free lunch.

## What is NOT predictable (don't build on these)
- **Tomorrow's direction.** Lag-1 autocorrelation is ≈ −0.03 (economically zero); 1-day
  continuation is ~47–48%. Daily returns are close to a random walk. (Ljung-Box flags
  *some* autocorrelation, but it's tiny and concentrated at medium horizons, not daily.)
- **Day-of-week / month / hour.** A couple of cells reach t>2 (BTC Monday is the best
  case, OOS-consistent), but they **disagree across BTC vs ETH** and are exactly what
  multiple-testing produces by chance (~1–2 false positives expected across 34 tests).
  Not a basis for a strategy.
- **Variance ratios** are near 1 (0.96–1.23) — close to random walk, with a mild momentum
  tilt at 20-day, consistent with finding #2.

## Why this matters (and ties the whole project together)
The two patterns that survive rigorous, OOS, multiple-testing-aware analysis are
**predictable volatility** and **medium-term momentum** — and those are *exactly* the two
the validated deployable engine is built on (`tsmom_blend` momentum + inverse-vol sizing,
`PER_COIN_BEST_STRATEGIES.md` / `ALL_WEATHER_SPINE.md`). So the strategy isn't curve-fit
to noise — it rests on the only two structural edges that independent pattern-testing
confirms exist. Conversely, everything the high-leverage day-trading goal needed
(predictable short-term direction) is the part that **isn't** predictable — which is the
deeper reason that goal failed.

## Honest caveats
- Patterns are weak in absolute terms; momentum's edge is a few % over weeks, not days.
- The bounce and calendar effects are at the edge of significance and should be treated as
  hypotheses, not facts, until confirmed on fresh data.
- All of this is unconditional structure; it does not include costs/slippage (the
  strategy docs do). Predictable ≠ profitable after costs — only momentum + vol-targeting
  cleared that bar in the full backtests.
