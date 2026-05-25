# Breadth Falsification Test (v1) — Verdict

## VERDICT: **KILL** — breadth is not the spine. Momentum reverts to a small beta overlay; stop iterating breadth as the foundation.

A dollar-neutral cross-sectional momentum strategy was built on a survivorship-free
universe and judged, out-of-sample, against four pass/kill criteria at the honest
50 bps/side cost. It **fails two of the four** — including the binding one (positive
2022) and the honesty gate (surviving 50 bps). Per the test's own rule, a clean kill
is the successful output: **size momentum small, call it beta, and do not spend more
research time trying to make breadth the spine.**

Code: [`research/breadth_test.py`](research/breadth_test.py) · results:
`research/results/breadth_test_results.json`.

---

## Scorecard (OOS, judged at 50 bps/side)

| # | Criterion | Threshold | Result | |
|---|---|---|---|:--:|
| 1 | **2022 return** | > 0% | **−8.4%** | ❌ FAIL |
| 2 | **Independent events** | ≥ 200 | **1,567** | ✅ PASS |
| 3 | **Concentration** (top-10 / gross +P&L) | < 50% | **13%** | ✅ PASS |
| 4 | **Cost survival** | Sharpe ≥ 0.7 & decay ≤ 40% | **Sharpe 0.43**, decay 34% | ❌ FAIL |

Two independent kill criteria are triggered (#1 and #4). **KILL.** Result is stable
across two independent harness configurations (Sharpe 0.42–0.43, 2022 −8.4%, ~1.6k
events, 13% concentration).

### Robustness confirmation — the kill is not a parameter artifact
A full-sample **look-ahead** upper-bound scan (every config, slow/low-turnover
rebalancing included, judged at 50 bps) shows the two binding criteria are **mutually
exclusive** — you cannot satisfy both even by cheating:

| "Best" config (full hindsight, 50 bps) | 2022 | Sharpe |
|---|---:|---:|
| max-2022 config (lookback 90, k=3, 14d) | **+41%** | 0.54 (< 0.7) |
| max-Sharpe config (lookback 30, k=3, 14d) | **−6.9%** | 0.76 |

No parameterization clears **both** 2022 > 0 **and** Sharpe ≥ 0.7. Worse, the only
config that wins 2022 uses **k=3 (6 positions)** — i.e. it earns 2022 by *concentrating*
into shorting a few collapsing coins, which is beta/concentration in disguise, not
breadth. Since look-ahead cannot pass, no honest OOS process can. **Definitive KILL.**

> Cautionary note (how easy it is to fake): a naive run that allowed 60–90d
> rebalancing in 180-day test folds silently dropped the low-period folds — which
> *removed 2022 from the OOS entirely* — and then printed a flattering Sharpe 1.20 on
> the surviving 2021/2023/2024 subset. That is exactly the fake-pass this test is built
> to reject; the harness was corrected so 2022 is always in the OOS window.

---

## What the numbers say

| | 6 bps/side (reference) | **50 bps/side (judged)** |
|---|---:|---:|
| OOS Sharpe | 0.66 | **0.43** |
| OOS CAGR | +21.3% | +9.9% |
| 2022 return | +4.0% | **−8.4%** |
| Median period (14d) | +0.41% | +0.24% |
| Events / concentration | 1,567 / 13% | 1,567 / 13% |

Per-year OOS (50 bps): 2021 **+139%** · 2022 **−8%** · 2023 **−6%** · 2024 **−43%** · 2025 **+39%**.

**Construction (all four anti-fakery guards honoured):**
- **Survivorship-free universe** — 55 USDT pairs, 2019→2026, with the corpses present
  and audited: LUNA $82→$0.00005 (May 2022), FTT $24→$2.10 (Nov 2022); 30+ coins
  −90/−100% in 2022; delisted names (MATIC, FTM, WAVES, EOS) end at their real dates.
  Point-in-time top-40-by-dollar-volume selection; **no coin excluded for dying.**
- **Dollar-neutral**, long top-k / short bottom-k by trailing return, ~zero net — no
  beta tilt. Short gains capped at +100%/position (ratio P&L), so the 2022 collapses
  are not over-credited.
- **Walk-forward OOS**, params (lookback, k, rebalance) chosen on each train fold by
  Sharpe at 50 bps and held fixed through the unseen test fold. Median-anchored.
- **50 bps/side + funding**; 6 bps shown only for reference.

---

## Interpretation — *why* it kills (and what survived)

**What the thesis got right (criteria 2 & 3 pass):** the strategy *is* genuinely
broad. 1,567 independent OOS events, with the top-10 events contributing only 13% of
gross positive P&L. This is **not** the 5-event momentum disease in a new costume —
the P&L is spread across hundreds of independent bets. The breadth *structure* is real.

**Why it still fails (criteria 1 & 4):**
1. **2022 dies at realistic cost.** The dispersion edge was supposed to earn in 2022
   regardless of direction. It barely did at 6 bps (+4%) and went **negative (−8.4%) at
   50 bps** — the 14-day rotation's turnover eats the thin edge exactly when it was
   most needed. The core promise of the spine fails.
2. **Execution-bound.** Sharpe is **0.43 at 50 bps**, below the 0.7 viability bar. The
   6→50 bps decay (37%) is *within* tolerance — i.e. the problem is not unusual cost
   sensitivity, it's that **the gross edge is simply too thin** to clear a deployable
   Sharpe after honest costs. This echoes the prior intraday-MR finding: thin
   cross-sectional crypto edges do not survive realistic execution.
3. **Bonus red flag (not a formal criterion):** event-level breadth did **not** buy
   regime robustness. The return is still concentrated *by year* — 2021/2025 carry it
   (+139%/+49%) while **2024 is −46%**. A spine that loses ~half in a normal year is
   not a spine.

---

## Decision consequence (per the goal)

- **Do NOT** rewrite the product goal as a breadth-spine + momentum-overlay book.
- **DO** treat the validated long-only momentum engine as a **small beta overlay**,
  sized modestly, with the drawdown-control overlay (`DRAWDOWN_CONTROL.md`) on top.
- **Stop iterating** dollar-neutral cross-sectional momentum as the foundation. A
  marginal, execution-bound, 2022-negative edge is not a spine. This test is closed.

> Note: this kills *cross-sectional momentum* as the breadth spine. It does not test
> other potential breadth sources (e.g. funding-rate / basis carry, options premium)
> — but those are **not validatable here** (Deribit and perp-funding endpoints are
> blocked), so any breadth-spine claim remains unproven on available data.
