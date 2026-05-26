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
