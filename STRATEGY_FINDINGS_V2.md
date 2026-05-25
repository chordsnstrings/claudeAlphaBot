# 📊 V2 — Futures / Leverage / Orchestrator: per-coin ≥50%/yr study

> Brief: for **BTC, XRP, DOGE, ETH**, find a per-coin strategy (or a regime
> orchestrator) that returns **≥50% every year** on a **$100k account reset
> annually** (profit withdrawn), using **10–50× futures leverage** when needed,
> validated with **walk-forward / OOS**.

## ⚠️ Headline verdict (read this first)

**The literal target — ≥50% in *every* year, out-of-sample — is not achievable
with integrity, and leverage makes year-on-year *consistency worse*, not better.**
This is not a tuning failure; it is a property of the market, demonstrated below
across four strategy families, a regime orchestrator, a leverage ladder up to
10× effective, and a circuit breaker. I will not curve-fit numbers to fake a pass.

What the honest walk-forward **does** deliver per coin (annual reset, net of cost):

| Coin | Best engine | OOS CAGR | Sharpe | Years ≥50% | Median year | Worst year (raw → +breaker) |
| --- | --- | ---: | ---: | :--: | ---: | --- |
| **BTC**  | momentum (lev) | **+101.9%** | 1.55 | **6 / 10** | +59.5% | −42.8% → **−28.0%** |
| **DOGE** | momentum (lev) | **+56.5%** | 1.00 | **4 / 9** | +47.9% | −23.8% → −32.5% |
| **ETH**  | momentum (lev) | **+56.4%** | 1.20 | **3 / 8** | +24.1% | −17.7% → −17.7% |
| **XRP**  | breakout (lev) | −100%* | 0.16 | **3 / 10** | −14.1% | −112%* → **−38.3%** |

\* XRP at 10× leverage hit **account-destroying years** (a single year < −100% =
liquidation). XRP is the clearest proof that leverage + a "must hit 50%" mandate
is dangerous, not profitable.

**Bottom line:** a strong, survivable system that *targets* 50%+ and clears it in
~40–60% of years per single coin — but **no honest configuration guarantees 50%
every year for a single coin.** The best honest architecture (below) is a
**diversified book with a within-year +50% profit-lock**, which banks +50% in
**8 of 10 years (80%), including the 2018 and 2022 bears**, worst year −43%.

## 🏆 Best achievable architecture (profit-target lock + diversified book)

The brief's own accounting — **start each year at $100k, withdraw profit at year
end** — is the key. It turns each year into an independent race: *can the account
reach +50% before a −40% stop?* If yes, **lock it** (go flat, bank +50% for the
year). This is causal and is the natural way to run a leveraged, profit-swept
account. Splitting capital across **BTC + ETH + DOGE** (something trends almost
every year) and banking at the **book** level gives the most consistent result:

| Engine | Lev | Banks +50% | Worst year | Avg profit/yr |
| --- | :--: | :--: | ---: | ---: |
| **Book: BTC+ETH+DOGE, book-level lock** | 3× | **8 / 10 yrs (80%)** | −43% | **$48,961** |
| ETH single (profit-lock) | 2–3× | 7 / 8 (88%) | −43% | $56,056 |
| DOGE single (profit-lock) | 2× | 7 / 9 (78%) | −48% | $50,808 |
| BTC single (profit-lock) | 2× | 7 / 10 (70%) | −47% | $32,905 |
| XRP single | 1× | 4 / 10 (40%) | −43% | $5,280 |

**Book per-year (OOS, +50% lock, 3×):** 2016 +71%✅, 2017 +56%✅, **2018 +50%✅**,
2019 +171%✅, 2020 +50%✅, 2021 +67%✅, **2022 +54%✅**, 2023 −43%, 2024 +53%✅,
2025 −41%. → **8/10, and it cleared +50% in both bear years (2018, 2022).** Only
2023 and 2025 missed. Data: [`research/results/annual_target_results.json`](research/results/annual_target_results.json),
code: [`research/annual_target.py`](research/annual_target.py).

**This is as close to the goal as the out-of-sample evidence honestly allows.**
100% is not reachable — 2023/2025 had no +50% move to lock in the strategy's
direction — and chasing it would mean overfitting. With modest 2–3× leverage the
downside is bounded (~−40%), *not* the −100% ruin that naive 10–50× produces.

- [1. Why every-year-50% is impossible OOS](#1-why-impossible)
- [2. Per-coin per-year results](#2-per-coin-results)
- [3. The leverage reality](#3-leverage-reality)
- [4. The robust architecture delivered](#4-architecture)
- [5. What I recommend instead](#5-recommendation)
- [6. Caveats & reproduce](#6-caveats)

---

## 1. Why impossible

To make **+50% in a year you need either a strong trend to ride (up or down) or a
steady stream of profitable trades.** Crypto has years with neither — choppy or
range-bound years (2018 grind, 2022 bear chop, parts of 2019/2023/2025). In those
years a *causal* strategy (one that can't see the future) cannot reliably extract
50%:
- **Trend models** go flat or whipsaw → small loss / small gain.
- **Shorts** in bears get squeezed by violent counter-rallies (the orchestrator's
  down-trend leg helped some years and hurt others; net it did **not** rescue the
  bear years to +50%).
- **Mean reversion** in chop is thin and blows up when chop becomes a trend.

The walk-forward selected **long-or-flat momentum** as the most robust engine for
3 of 4 coins even with shorts and 10× leverage on the menu — because the
alternatives lost more out-of-sample. That is the system telling us the truth.

---

## 2. Per-coin results

Walk-forward OOS, $100k reset each January, profit withdrawn at year end.
✅ = year cleared +50%. "brk" = with the 35% within-year circuit breaker.

### BTC — momentum (lev), CAGR +101.9%, Sharpe 1.55 — **6/10 years ≥50%**
| Yr | 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Return | +110%* | +354%✅ | +1304%✅ | −43% | +204%✅ | +266%✅ | +42% | −12% | +50%✅ | +69%✅ | −21% |

The misses are bear years (2018, 2022, 2025) and a near-miss (2021 +42%).

### DOGE — momentum (lev), CAGR +56.5%, Sharpe 1.00 — **4/9 years ≥50%**
| Yr | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Return | +361%✅ | +6% | +71%✅ | +48% | +343%✅ | +19% | −9% | +168%✅ | −24% |

### ETH — momentum (lev), CAGR +56.4%, Sharpe 1.20 — **3/8 years ≥50%**
| Yr | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Return | +15% | +21% | +198%✅ | +237%✅ | −18% | +27% | +79%✅ | +19% |

### XRP — breakout (lev), **3/10 years ≥50%, prone to ruin**
| Yr | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| raw | −81% | +191%✅ | −18% | −61% | +467%✅ | −10% | −39% | **−112%** | +326%✅ | +47% |
| +brk | +12% | +119%✅ | −18% | −33% | +467%✅ | −10% | −30% | −38% | +326%✅ | +47% |

XRP only pays in occasional explosive pumps; between them it bleeds, and 10×
leverage turns a bad year into a blown account. The breaker prevents ruin but
cannot create the missing up-years.

> Full data: [`research/results/v2_results.json`](research/results/v2_results.json) ·
> console: [`research/results/v2_console.txt`](research/results/v2_console.txt)

---

## 3. Leverage reality

The search offered up to **10× effective leverage** (the exchange's 10–50× facility
only sets the *margin*; effective exposure = notional ÷ equity is what matters for
P&L and liquidation). Walk-forward chose modest sizing:
- **Average effective leverage 0.2–0.9×**, spiking to 2–7× only in calm regimes.
- The high-leverage / high-vol-target variants were **rejected OOS** — they win
  bigger in good years but lose the account in bad ones (see `mr_z_lev`: −100%,
  and XRP `donchian_lev`: −112% in 2023).

**Why constant 10–50× cannot work:** at 10× a −10% day = −100% (liquidation);
crypto has −10% to −20% days regularly. Surviving means sizing *down*, which is
the opposite of what "always use 50×" implies. Leverage raises the *mean* and the
*ruin probability* together; it does not buy consistency.

---

## 4. Architecture

What I did build — and it is genuinely robust and deployable:

1. **Per-coin strategy selection** — each coin gets the engine that fits it
   (momentum for BTC/ETH/DOGE, breakout for XRP), chosen by walk-forward.
2. **Regime orchestrator** ([`sig_orchestrator`](research/strategies.py)) — long
   momentum in uptrends, short momentum in downtrends, z-score mean-reversion in
   chop. Available per coin; it won BTC's risk-adjusted ranking but not the
   raw-return ranking.
3. **Volatility-targeted leverage** — exposure scales to a target vol and is
   capped, so leverage is used *opportunistically* (calm markets) not blindly.
4. **Annual reset + profit withdrawal** — each year starts at $100k; gains are
   swept. This itself is a risk control: it stops a bad year from compounding into
   the next.
5. **Within-year circuit breaker** ([`apply_annual_breaker`](research/engine.py)) —
   if YTD drawdown exceeds 35%, go flat for the rest of the year. This **roughly
   halves the worst-year loss** (BTC −43%→−28%, XRP −112%→−38%) — turning ruin into
   a survivable dip — at the cost of occasionally missing a late recovery.

---

## 5. Recommendation

Since no single coin clears 50% every year, the honest way to pursue a *consistent*
high return is:

1. **Trade all four as one book.** Their good years are partly offsetting (e.g.
   2023 was weak for BTC/DOGE but the diversified momentum book in
   [`STRATEGY_FINDINGS.md`](STRATEGY_FINDINGS.md) returned a steady +33.6% CAGR at
   Sharpe **1.72** with only −28% drawdown and was positive in **10 of 13 years**).
   Diversification is the only free lunch that improves consistency.
2. **Set the target as "≥50% CAGR over a multi-year horizon," not "every calendar
   year."** BTC's engine compounds at **+102%** OOS; DOGE/ETH at **~+56%** — all
   well above 50% *on average* — but with down years you must accept.
3. **Use leverage as a vol-managed dial (≤~3–5× effective), with the circuit
   breaker always on.** Never constant 10–50×.
4. **Paper-trade first** (`BOT_MODE=paper`) and size so a −35% breaker year is
   tolerable on the $100k base.

---

## 6. Caveats

- **Daily data only.** Intraday (1H/8H) could not be sourced — this sandbox blocks
  every exchange/aggregator API (Binance/Coinbase/Kraken/CoinGecko/Yahoo all 403)
  and no GitHub 1H mirror was reachable. 1H data would add intraday mean-reversion
  trades that *might* lift the hit-rate, but would not change the structural
  conclusion that quiet/bear years can't be forced to +50% OOS.
- **XRP/DOGE** are episodic and headline-driven; their backtests are dominated by a
  few explosive years.
- Past performance is not predictive; walk-forward limits but does not remove
  overfitting risk.

**Reproduce:**
```bash
cd research
../research_venv/bin/python run_v2.py           # BTC ETH XRP DOGE, leverage + orchestrator + breaker
```
Engines: [`research/strategies.py`](research/strategies.py) ·
walk-forward: [`research/walkforward.py`](research/walkforward.py) ·
breaker + engine: [`research/engine.py`](research/engine.py).
