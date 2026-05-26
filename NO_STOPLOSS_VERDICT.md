# "No stop-loss, TP +40/50/60%, never exit at a loss" — tested on ETH

Verdict: **this is the classic blow-up pattern. With leverage it is mathematically
suicidal; on spot it is just buy-and-hold with capped upside and the loss hidden as
"unrealised."** Measured on real ETH (2016→2026). Code:
[`research/eth_no_sl.py`](research/eth_no_sl.py).

## 1. With leverage, you do NOT get to "never exit at a loss" — the exchange does it for you
The liquidation engine force-closes you at −100% on a ~1/leverage adverse move. How often
ETH actually moved that much:

| Leverage | liquidation move | days that liquidate a no-SL long |
|---|--:|--:|
| 5× | −20% | 6 days (0.16%) |
| 10× | −10% | **75 days (2.1%)** |
| 20× | −5% | **320 days (8.8%)** |

At 10× a no-SL long is wiped on any of ~2% of days; at 20×, ~9% of days. Over any real
holding period that is **near-certain liquidation**. "Never exit at a loss" is not a
choice you can make with leverage — **liquidation IS your stop-loss, set at −100%.**

## 2. On spot, it's worse than just holding — the "wins" are an accounting illusion
"TP +50%, re-enter, never sell at a loss," full capital, no leverage:

| TP level | booked winning exits ("win rate") | realised equity (illusion) | **mark-to-market equity (reality)** | maxDD |
|---|--:|--:|--:|--:|
| +40% | 14 (100%) | 111× | **60×** | −94% |
| +50% | 12 (100%) | 130× | **71×** | −94% |
| +60% | 11 (100%) | 176× | **77×** | −94% |
| buy & hold | — | — | **152×** | −94% |

The "100% win rate / 130× realised" is fiction — you only *book* the winners and leave
losers open. The real account (mark-to-market) is **70× vs 152× for plain buy-and-hold**:
capping gains at +50% while refusing to cap losses **roughly halves your return** and keeps
the **full −94% drawdown**. You underperform doing nothing.

## 3. "Never exit at a loss" = capital frozen for years
- Longest stretch ETH stayed below a prior peak: **1,382 days (3.8 years).**
- A buyer at the all-time high who "never sells at a loss" is **still −56% underwater** at
  the end of the sample. The promise is kept only on paper — the capital is **dead money**
  for 3–4+ years.

## Why the rule is backwards
Capping gains at +40/60% while letting losses run is **negative skew**: many small capped
wins, rare catastrophic or eternal losers. You get a *high win rate* and *negative
expectancy* — the textbook "picking up pennies in front of a steamroller." Every durable
edge in this project does the opposite: **cut losers, let winners run.** Momentum, the
all-weather spine, the per-coin engines — all of them exit losing trends and ride winning
ones. This rule inverts the one thing that works.

## What to do instead (keeping the spirit — "don't get stopped out of good positions")
- **Drop leverage, not the stop.** The real fix for "stops keep knocking me out" is *smaller
  size*, not *no stop*. At 1–2× a wider stop survives normal noise without risking the account.
- **If you truly want "never realise a loss": that is unleveraged spot holding of majors** —
  i.e. plain buy-and-hold (which beat the capped version, 152× vs 70×). No bot needed, and
  you still wear −80/−94% drawdowns for years.
- **Keep the withdraw-principal-at-2× rule** from `LEVERAGE_BTC_ETH.md` at ~5× max — that is
  the honest way to "play with house money," and it works *because* it caps risk, not because
  it ignores it.

Bottom line: "no SL, never exit at a loss" doesn't remove risk — it **hides** it (as
unrealised loss) until leverage converts it into **liquidation**. It is the most common way
retail accounts go to zero.
