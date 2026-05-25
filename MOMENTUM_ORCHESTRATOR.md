# Long-Only Momentum Orchestrator — top-30 Binance coins

Automatically picks the right asset at the right time to go **long**, from the top-30
liquid Binance USDT coins, on momentum. Walk-forward out-of-sample. Code:
[`research/orchestrator_long.py`](research/orchestrator_long.py) → outputs today's
picks and `research/results/orchestrator_long_results.json`.

---

## What it does (the orchestrator)

Each rebalance:
1. **Universe** — rank all live coins by 30-day dollar volume, take the **top 30**
   (point-in-time, survivorship-free — dead names like LUNA/FTT are present and drop
   out as they die).
2. **Signal** — per coin, `tsmom_blend` conviction = fraction of lookbacks
   `[10,30,60,120]` currently in uptrend (∈ [0,1]); strength = mean trailing return.
3. **Select** — among coins with conviction ≥ **gate (0.5)**, go **long the top-N (5)**
   by strength. **If fewer than N qualify, hold fewer — the rest is CASH.** This cash
   filter is the "right time": in a broad downtrend few coins qualify, so the book
   automatically de-risks toward cash instead of forcing longs into a falling market.
4. **Size** — equal-weight the picks, then portfolio inverse-vol target (0.6), cap 2×.

This is an honestly **long-only, net-long (beta-bearing)** strategy. The dollar-neutral
version was falsification-tested and **killed** (`BREADTH_TEST_VERDICT.md`); this one
keeps the beta on purpose, which is exactly why it has a real, cost-robust return.

---

## Out-of-sample results (walk-forward; params fixed on train fold)

| Cost/side | CAGR | Sharpe | maxDD | 2022 | Events | Top-10 / +P&L |
|---|---:|---:|---:|---:|---:|---:|
| 6 bps | +46.7% | 1.14 | −45% | −35% | 687 | 24% |
| **15 bps** | **+44.5%** | **1.15** | −44% | −38% | 618 | 27% |
| 30 bps | +31.9% | 0.88 | −52% | −38% | 601 | 27% |

Per-year OOS (15 bps): 2021 **+183%** · 2022 **−38%** · 2023 **+158%** · 2024 **+34%** · 2025 **+1%**.

**Two things stand out:**
- **Cost-robust.** CAGR holds ~45% through 15 bps and Sharpe stays ≥ 0.88 at 30 bps —
  unlike the dollar-neutral breadth strategy that collapsed at cost. Long-only momentum
  has a large return source (alt trend/beta), not a thin dispersion edge.
- **Genuinely broad** (~620 events, top-10 = 24–27% of positive P&L), *and* it earns —
  the combination the breadth test could not get from a dollar-neutral book.

---

## "Optimize and trade more to get more?" — the honest answer: trading more does NOT help

Frequency/position sweep, NET CAGR & Sharpe at 15 bps (full-sample):

| Rebalance | rebals/yr | best Sharpe (N) | best CAGR |
|---|---:|---:|---:|
| 3 days | 122× | 0.87 (N=3) | 42% |
| 7 days | 52× | 0.76 (N=5) | 32% |
| **14 days** | **26×** | **0.99 (N=5)** | **53%** |
| 30 days | 12× | 0.82 | 37% |
| 60 days | 6× | 0.82 (N=5) | 40% |

**The sweet spot is 14-day rebalancing with N=5** (Sharpe ~0.99). Trading *more* often
(3-day = 122×/yr, 7-day = 52×/yr) makes it **worse** — CAGR drops to 28–42% and Sharpe
to 0.66–0.87 — because turnover cost and whipsaw eat the edge faster than higher
frequency adds signal. This reproduces the project-wide finding: **frequency ≠ edge;
more clicks just add cost.** The optimization that *does* add return is structural
(right universe, conviction gate, N=5, 14-day clock, vol-target), not a faster clock.

### What about stacking the drawdown brake? (cuts risk, but costs return here)
| Variant (15 bps, OOS) | CAGR | Sharpe | maxDD | 2022 | Calmar |
|---|---:|---:|---:|---:|---:|
| Orchestrator | +44% | 1.15 | −44% | −38% | **1.01** |
| + graded dd-brake | +22% | 0.93 | **−29%** | **−23%** | 0.78 |

The equity-curve drawdown brake (from `DRAWDOWN_CONTROL.md`) **does** cut maxDD
(−44%→−29%) and the 2022 bleed (−38%→−23%) — but it **lowers Calmar (1.01→0.78)** and
halves CAGR, because the orchestrator's own cash filter already times the regime, and
the brake stays de-risked into the explosive 2023 recovery (+158%). **Verdict: the
brake is optional** — use it only if you value drawdown reduction over total return;
the orchestrator's built-in cash filter is the better risk control for this book.

---

## Live output (today, 2026-05-25)

Top-30 liquid, gate 0.5, N=5 — the orchestrator is currently long:

| Asset | Momentum | Conviction |
|---|---:|---:|
| ZEC | +106% | 1.00 |
| NEAR | +91% | 1.00 |
| TRX | +17% | 1.00 |
| DASH | +14% | 0.75 |
| ATOM | +10% | 0.75 |

(If too few coins qualified, it would report CASH for the empty slots.)

---

## Honest caveats
- **2022 still bleeds (−38%).** The cash gate reduces but does not eliminate the bear:
  long-only alt momentum gets whipsawed by bear-market rallies before momentum flips.
  It is **not** market-neutral; it carries alt beta. (The market-neutral attempt to
  earn in 2022 was killed — see `BREADTH_TEST_VERDICT.md`.) Pair with hard annual/monthly
  stops; the dd-brake is available if you must cap drawdown further.
- **Return is regime-lumpy** — 2021/2023 carry it (+183%/+158%); 2025 was ~flat. It is
  a bull/trend harvester, not an all-weather engine.
- **Capacity/slippage** — top-30 liquidity supports the 6–15 bps assumption at modest
  size; large notional in the smaller names (ZEC, DASH) needs care.
- **Deploy:** run `orchestrator_long.py` daily; it prints the long set. Rebalance on a
  14-day clock, vol-target 0.6, N=5, gate 0.5. Paper-trade first.

**Bottom line:** a working long-only momentum orchestrator that auto-selects the
strongest top-30 coins and sits in cash when none qualify — **~45% CAGR / Sharpe 1.15
OOS at 15 bps, cost-robust**, broad (~620 events). The way to "get more" is the
14-day / N=5 / vol-target structure, **not** trading more often (which measurably
reduces net return).
