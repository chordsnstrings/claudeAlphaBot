# High-Leverage BTC/ETH Day-Trading — Complete Strategy Catalog & Verdict

The goal: *"find the different strategies day-traders use for consistent 20–30%/month at
10–20× on BTC/ETH; optimise for 20–50% monthly; return initial capital fast, then play
house money."* This catalogues **every** strategy archetype tested for that goal, what
each delivers, and the conclusion. All on real BTC/ETH data (2020-05→2026), survivorship-
free, with **realistic intra-bar liquidation** (the thing that separates fantasy from
reality at high leverage).

## The headline verdict
**Consistent 20–30%/month at 10–20× is not achievable by any strategy — it is
survivorship bias.** Every archetype below either (a) ruins at 10–20× on the first real
trend, or (b) only survives at 2–3×, where the returns are good but far below the headline
and the "fast" part disappears. The single variable that decides the outcome is
**leverage**, not the strategy. The genuinely smart part of the plan — *withdraw principal
at 2×, then play house money* — works, but **only at 2–3×**.

## The catalog (each at 10–20×, judged honestly)

| # | Strategy archetype | Result at 10–20× | Why it fails | Doc |
|---|---|---|---|---|
| 1 | **Leveraged momentum / trend** | median month negative; 8×+ compounds to ~0; ruin | signal not accurate enough to survive leveraged whipsaw | `LEVERAGE_BTC_ETH.md` |
| 2 | **Leveraged breakout (intraday 1h)** | worse than daily; −95/−99% maxDD | costs + whipsaw dominate at higher frequency | `SOFTWARE_SPEC §18.2` |
| 3 | **DCA averaging-down grid** | RUIN (May-2022; slow −91% from 2023) | adds margin to a losing position; liquidation at −5% fires before the −20% add | `GRID_DCA_VERDICT.md` |
| 4 | **No-SL / never-exit-at-loss** | liquidation IS the stop, at −100% | "never lose" impossible under leverage; spot = capped buy-hold that underperforms | `NO_STOPLOSS_VERDICT.md` |
| 5 | **Scalping / mean-reversion** | net-negative after costs | thin edge eaten by fees/funding | `SOFTWARE_SPEC §12.7` |
| 6 | **Martingale (double-after-loss)** | backtest shows absurd fake gains (1e21×); guaranteed eventual ruin | finite bankroll + a ~5-loss streak = total wipe; max backtest-vs-reality gap | this doc |
| 7 | **Pyramiding (add-to-winners)** | RUIN (2022-05 / 2026-03) | = momentum; pullbacks liquidate the leveraged stack | this doc |
| 8 | **Copy-trading the leaders** | you buy the survivor at his peak, into a live underwater 20× position, with a lock-up | survivorship + small-account % + profit-share incentive ≠ your edge | (screenshot analysis) |

## The two recurring illusions that make these look like they work
1. **High win rate ≠ edge.** Every grid/no-SL/martingale variant posts 78–97% win rates —
   because they book small winners and *hold/double* losers. The rare loss is a
   liquidation (−100% of a growing stack). Win rate is the bait; the liquidation tail is
   the hook.
2. **Close-only / no-intra-bar backtests lie.** At 20× the liquidation distance is ~5%,
   *inside* a single candle. Two separate backtests here printed fantasy numbers
   (+678× grid, +1e21× martingale) until intra-bar liquidation was modelled — then they
   flipped to ruin. The wild screenshots in the wild are the live version of this lie:
   the +2,200% is the good window before the liquidation that isn't on the chart yet.

## What actually works (the answer to the real goal)
The plan — *return principal fast, then gamble house money* — is sound. The only fix is
leverage. Withdraw-principal-at-2× on the validated momentum engine:

| Leverage | P(return principal) | months to 2× | P(ruin) | 3 rounds in a row |
|---|--:|--:|--:|--:|
| **2×** | **97%** | ~10 | **0%** | 90% |
| 3× | 94% | ~7 | 5% | 83% |
| 5× | 74% | ~5 | 53% | 40% |
| 10–20× | 1–30% | — | ~94–100% | 0–3% |

**Consistent capital extraction is real at 2–3× (94–97% per round, near-zero ruin) and
impossible at 10–20×** (the account bleeds out before it doubles). Speed comes from
leverage; survival-to-2× comes from low leverage; they are opposites — you get
consistent-and-slow (2–3×) or explosive-and-fragile (20×), never both.

## Recommendation
Run the validated **momentum / all-weather engine at 2–3×** (`PER_COIN_BEST_STRATEGIES.md`,
`ALL_WEATHER_SPINE.md`), withdraw principal at 2× (~7–10 months, 94–97% reliable, ~0%
ruin), then play house money exactly as intended. Accept that "20–50%/month at 10–20×" is
not a strategy that exists — it is a screenshot of someone's good window, taken before the
liquidation. The honest, durable version of the same idea is ~2–3×.
