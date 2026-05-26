# DCA grid, 20× leverage, +20% TP, ETH hourly — tested (and a backtest trap exposed)

Tested the exact proposal: 20× long ETH on 1h bars, deploy 5% margin/tranche, **DCA
(average down) every −5%, take profit at +20% on margin** (= a +1% price bounce off the
averaged entry). Code: [`research/grid_dca_eth.py`](research/grid_dca_eth.py).

## Verdict: RUIN — wiped out 2022-05-12 (−95%)

| Run (intra-bar liquidation, honest) | win rate | liquidations | final equity | ruin |
|---|--:|--:|--:|--:|
| **20×, +20% TP (your strategy)** | 83.4% | 439 | **0.048×** | **YES, 2022-05-12** |
| 20×, +50% TP | 67% | 838 | 0.091× | −91% |
| 10×, +20% TP | 92% | 140 | 0.251× | −75% |
| 10×, +50% TP | 81% | 123 | 2.90× | survived |
| 5×, +20% TP | 96% | 21 | 0.875× | slightly down |
| 5×, +50% TP | 88% | 20 | 2.95× | survived |

Path of your config: 2020 +12% → end-2021 it had bled to 0.12× → **ruined May 2022.**
A **96%/92%/83% win rate and it still goes to zero** — because the rare losses are
liquidations (−100% of a growing, averaged-down stack) and the wins are tiny (+1% of
equity). That is the DCA-grid death: prints money for ~2 years, one real downtrend ends it.

## The trap I almost reported as a win (this is the important part)
My **first** run used closing prices and showed **+678×, no ruin.** That was a *bug*,
not an edge. At 20× the liquidation distance is only **5%**, which is *inside* a typical
1h candle's high-low range — so a close-only backtest **misses every intra-bar
liquidation** where the low blew through −5% but the candle closed green. Checking
liquidation against the actual 1h **low** (liquidation is an unconditional hard trigger —
once price touches it, you're closed, regardless of the close) flipped **+678× into −95%
ruin.**

This is precisely why these strategies fool people: a naive backtest (and a few lucky
live months in an up-market) makes a 20× martingale grid look magical, while the real
mechanic — intra-bar liquidation in the first sustained downtrend — is invisible until it
wipes the account. **78–96% win rates are the bait; the liquidation tail is the hook.**

## Why DCA + leverage is structurally doomed
- **Averaging down adds margin to a losing position.** At 20×, you're liquidated when
  price is ~5% below your *average* entry. DCA lowers the average, but each add commits
  more capital, so when a trend finally breaks through, you lose a *bigger* stack.
- **The grid step (−5%) equals the liquidation distance (−5%) at 20×** — you often get
  liquidated *at the same level you wanted to add*, intra-bar, before any bounce.
- **The payoff is inverted:** +1% of equity per win vs −5%-to−40% per liquidation. You
  need an ~83%+ win rate just to break even before fees — and the fees at 20× (~1% of
  margin/side) and the DCA-enlarged losses push the real break-even out of reach.

## What even the "survivors" tell you
The only configs that survived (10×/+50%, 5×/+50%) made **~2.9× over 6 years** — while
simply **holding ETH over the same window made ~8.8×.** So the grid that *didn't* blow up
still **underperformed doing nothing**, and carried ruin risk the whole way. There is no
version of this that beats the validated 2–3× momentum / all-weather engines.

## Bottom line
The 20× ETH DCA grid is a **blow-up, ruined in the first real bear (May 2022)**, and the
backtest that says otherwise is lying to you via close-only liquidation. DCA averaging-
down at high leverage isn't risk management — it's **adding chips to a hand the exchange
will eventually take all at once.** Same fate as every leveraged no-cut-loss variant
tested here; the 2022 trend is the universal executioner.

## "Start from 2023 instead" — it doesn't save 20×, it just changes how it dies
Re-ran starting 2023-01-01 (skipping the 2022 bear entirely) and through the FTX window:

| Window | 20× | 10× | 5× |
|---|--:|--:|--:|
| **From 2023-01** (to 2026-05) | **0.09× (−91%)** | 0.65× (−35%) | 1.41× (+41%) |
| FTX window (Oct-22→Mar-23) | 0.76× (−24%, 37 liqs) | 1.41× | 0.93× |
| ETH buy-and-hold, 2023→2026 | — | — | **1.73×** |

- **20× still loses 91%** even starting after 2022 — not a one-day blow-up this time, a
  *slow death* by repeated liquidations through the 2024 correction and the 2025→2026 ETH
  selloff (price fell from ~$4,100 to ~$2,065, −50%). There is **no entry year that makes
  20× safe**, because ETH always has periodic −30%/−50% drawdowns and 20× dies on each one.
- The **FTX collapse (Nov-2022)** caused 37 liquidations and a −24% hit at 20× in that
  window — survivable over a few months, but only because it was a short window.
- The only leverage that survived (5×) made **+41%** from 2023 — but **simply holding ETH
  made +73%** over the same window. So even the non-blow-up grid **underperformed doing
  nothing**, while taking liquidation risk and a 96% "win rate" that hid the bleed.

**The lesson generalises:** picking a start date *after* the crash that killed it is
regime cherry-picking, and even then the next drawdown (there is always a next drawdown)
liquidates 20×. The grid's high win rate is constant (83–96%) across every window; it
still loses at high leverage, because the losses are liquidations. Win rate is not edge.

## "But does 20× return my initial capital faster?" — No. It never returns it at all.
The withdrawal model ("pull principal once equity = 2×, then play house money") only
works if the account can actually *double*. It can't at 20×:

| Leverage | reaches 2× (realized, 2023→)? | days to 2× | P(return principal) MC | P(ruin before) |
|---|--:|--:|--:|--:|
| **20×** | **NEVER** (peak 1.6×) | — | **1%** | 27% |
| 10× | yes | 429 | 24% | 1% |
| **5×** | **yes** | **406** | **52%** | 0% |
| 3× | yes | 561 | 18% | 1% |

**Higher leverage returns capital *slower*, not faster — and at 20×, never.** To withdraw
principal the account must net-double, which needs positive compound drift. At 20× the
liquidation bleed exceeds the +1%-price wins, so drift is **negative** — equity trends
down, peaks ~1.6×, and never reaches the 2× trigger. The "more leverage = faster payback"
intuition is backwards: more leverage = more liquidation bleed = negative drift = the
account shrinks instead of doubling. Capital comes out **fastest and most reliably at
~5×** (52% chance, ~400 days, survives). The withdrawal rule cannot save 20× because 20×
never gets to 2×.

## Update — 20% grid / 5% tranche / +40% TP (refined spec)
Tested the refined parameters (add a 5% tranche every −20%, take profit at +40%):

| exit meaning | 20× | 10× | 5× |
|---|--:|--:|--:|
| +40% on margin (+2% price) | **0.049× — RUIN 2025-02** | 1.45× | 1.94× |
| +40% price move | 3.49×* | 4.03×* | 2.15× |

\* the 20×/10× "+40% price" survivors are **regime luck** — they caught the 2020 & 2023
mega-rallies off averaged-down lows (win rate only 15–27%); from a 2023 start they never
even double (~1.2×). Not robust.

**The decisive structural point:** at 20× you are liquidated at **−5% below the average
entry**, but the grid only adds at **−20%** — so **liquidation always fires before the
first DCA add.** You never actually average down; the "DCA into a better position" is
**dead on arrival at high leverage.** Widening the grid or raising the TP cannot help when
the position is closed at −5% first. The refined spec still ruins at 20× (Feb 2025 instead
of May 2022 — a later death, not a cure). The adds only *fire* — and the strategy only
survives and returns principal — at **~5×**, where the liquidation distance (−20%) finally
matches the grid step. Leverage is the only variable that changes the verdict.
