# High-Leverage BTC/ETH Day Trading + "Return Principal Fast" — the honest math

Tests the popular plan — **10–20× leverage on BTC/ETH for 20–30%+ monthly, accept high
drawdown, withdraw the initial capital ASAP, then play with house money.** Best
long/short daily momentum signal, executed on 1h bars with intraday trailing stops and
**realistic liquidation** (a 1h move ≤ −1/m wipes a long; ≥ +1/m wipes a short — this is
how 10–20× actually dies). Survivorship-free, 2020-05→2026 (the 2021 bull, 2022 bear,
2023–25). Code: [`research/leverage_btc_eth.py`](research/leverage_btc_eth.py).

> **The headline you were sold is survivorship bias.** "Consistent 20–30%/month at
> 10–20×" is what the lucky tail posts; the ~90% who ran the same leverage and blew up
> don't. The data below shows why — and shows the *one* part of your plan that is
> genuinely smart (withdraw principal), plus the leverage at which it actually works.

---

## 1. Monthly return distribution per leverage (reset each month)

| Leverage | median month | %≥+20% | %≥+30% | %≥+50% | worst month | compounded* |
|---|--:|--:|--:|--:|--:|--:|
| 5× | **−11%** | 28% | 25% | 19% | −54% | +3% |
| 8× | −21% | 22% | 17% | 16% | −83% | −81% |
| 10× | −23% | 17% | 16% | 13% | −89% | −92% |
| 15× | −43% | 12% | 10% | 9% | −98% | −100% |
| 20× | **−59%** | 13% | 13% | 12% | −100% | **−100%** |

\* compounded path if you never withdrew — i.e. what actually happens to a buy-and-hold-the-strategy account.

**Read this carefully:** the **median month is *negative* at every leverage**, and gets
*more* negative as leverage rises (−11% at 5× → −59% at 20×). You hit +20% in only
13–28% of months — those are the **lucky right tail**, not the norm. Higher leverage
does **not** raise the win rate; it just deepens the losing months. Compounded, 8×+ goes
to **zero** (−81% to −100%). The intraday stops prevent *instant* liquidation (liq-month
rate ~0–1%) but can't stop **death by a thousand 15% stop-outs** at high leverage.

This is the mathematical reason "consistent 20–30%/month" is a myth: the signal isn't
accurate enough to survive 10–20× turnover/whipsaw — the typical month bleeds.

---

## 2. The withdrawal model — the smart part of your plan, quantified

Monte Carlo (20,000 paths, 36-month horizon): start $P, apply leveraged monthly returns,
**withdraw the principal $P the first month equity ≥ 2×**, then trade only house money; a
−100% month ends the path in ruin.

| Leverage | P(return principal) | median months to return | **P(ruin BEFORE return)** | P(ruin ever) | median house money |
|---|--:|--:|--:|--:|--:|
| **5×** | **71%** | 5 | 22% | 33% | **1.96×** |
| 8× | 41% | 4 | 58% | 84% | 0.05× |
| 10× | 35% | 3 | 65% | 94% | 0.04× |
| 15× | 21% | 2 | 79% | 100% | 0.03× |
| 20× | 12% | 2 | **88%** | **100%** | 0.02× |

**The verdict on 10–20×:** you blow up *before* recovering your principal **65–88% of the
time**, and you are ruined eventually **94–100% of the time**. The "return principal fast,
play house money" rule **cannot protect you at 10–20× because ruin arrives first** — you
never reach the 2× withdrawal trigger.

**The leverage that makes your plan actually work is ~5×, not 10–20×:** 71% chance to
recover principal in ~5 months, after which you hold ~2× as house money, with a 33% chance
of eventual ruin (which — once principal is withdrawn — costs only house money, exactly as
you intended). Going from 5×→10× trades 2 months of speed for a 22%→65% jump in
ruin-before-return. **More leverage is strictly worse for this goal.**

---

## 3. The strategies day-traders actually use (and why none give consistent 20–30%)
- **Leveraged trend/breakout** (long/short momentum) — what's modelled here; real edge,
  but thin, and the leverage is the killer.
- **Tight intraday stops** — mandatory at 10×+ (a 10% move = liquidation), and they DO
  prevent instant ruin — but they convert ruin into a steady bleed (median month negative).
- **Scalping/mean-reversion** — already shown net-negative after costs (`SOFTWARE_SPEC` §12.7).
- The differentiator for the rare consistent winners is **position sizing and surviving**,
  not a magic signal: they risk a small % per trade, use modest *effective* leverage, and
  the "20–30% months" are good streaks inside a high-variance path — survivorship visible,
  ruin invisible.

---

## 4. Honest recommendation for your goal
1. **Do not run 10–20×.** The math is unambiguous: ~94–100% eventual ruin, 65–88% before you
   ever recover principal. It is not a strategy, it's a coin-flip you lose.
2. **If you want the "double then play house money" plan: ~5× is the sweet spot** —
   best realistic odds (71% recover principal, ~2× house money, ~5 months). Even this is a
   gamble (1-in-3 ruin), not income.
3. **The withdrawal rule is genuinely smart — keep it, just at sane leverage.** Withdraw
   principal the instant equity hits 2×; from then on you are playing free, and a blow-up
   costs only the casino's money.
4. **Best risk-adjusted alternative** if the real aim is to grow capital fast without near-
   certain ruin: the validated 2–3× momentum / all-weather spine engines
   (`PER_COIN_BEST_STRATEGIES.md`, `ALL_WEATHER_SPINE.md`) — far lower monthly variance,
   no ~100% ruin tail.

## Caveats
- **Optimistic if anything:** daily bars within the 1h execution miss intra-hour gaps; a
  real overnight gap-through-stop at 15–20× liquidates harder than modelled, so live ruin
  is *worse*, not better.
- Bootstrap assumes months are independent (ignores crashes clustering), and uses a real
  validated signal — a worse signal (most retail systems) gives worse odds.
- This is BTC+ETH 50/50; single-coin concentration raises variance and ruin further.
- Past performance is not predictive; leverage ruin is permanent.

## Update — "why couldn't we take out the capital consistently?" (the synthesis)
We CAN — but only at sane leverage. The withdraw-principal-at-2× plan, on the validated
momentum engine:

| Leverage | P(return principal) | median months to 2× | P(ruin ever) | P(extract 3 rounds) |
|---|--:|--:|--:|--:|
| **2×** | **97%** | 10 | **0%** | **90%** |
| 3× | 94% | 7 | 5% | 83% |
| 5× | 74% | 5 | 53% | 40% |
| 8× | 47% | 2 | 99% | 10% |
| 20× (grid) | **1%** | — | ~100% | **0%** |

**Consistent extraction is real at 2–3× (94–97% per round, ~0% ruin, ~83–90% over three
rounds in a row).** It is impossible at 10–20× because the negative drift (liquidation
bleed) means the account almost never reaches the 2× withdrawal trigger (1% at 20×).

The conflict is fundamental: **extraction *speed* comes from leverage; extraction
*reliability* comes from surviving to 2×; high leverage destroys survival.** You can have
consistent-and-slow (2–3×, ~10 months to double, 97% reliable) or explosive-and-fragile
(20×, 72-day moonshots, ~1% you ever see the principal again) — never both. The +2,200%
screenshots require the leverage that makes consistent extraction impossible. The fix to
the whole "return principal then play house money" plan is one variable: 20× → 2–3×.
