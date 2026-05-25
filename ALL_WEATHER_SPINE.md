# All-Weather Spine — Long/Short Time-Series Trend ("Crisis Alpha")

## Verdict: FOUND. A long/short time-series trend book is genuinely all-weather — the first construction in this project that **earns in 2022** while staying positive across regimes.

Every prior engine hit the same wall: 2022. Long-only momentum bleeds it (−38%); the
dollar-neutral breadth book was **killed** (thin edge, −8% in 2022 at cost). The
missing ingredient was the ability to **short a confirmed downtrend** — managed-futures
"crisis alpha." A long/short time-series-trend book has it, and it works.

Code: [`research/all_weather.py`](research/all_weather.py) · results:
`research/results/all_weather_results.json`. Walk-forward OOS, survivorship-free
top-30 universe (corpses present).

---

## The spine (OOS, walk-forward, 15 bps/side)

**Pure time-series trend, long/short, inverse-vol weighted** — each coin is held long
if its multi-lookback trend is up, **short if down**, vol-weighted (so violent
collapses like LUNA get near-zero weight; the P&L comes from the broad orderly
downtrend, not the few corpses).

| Year | Return | Regime |
|---:|---:|---|
| 2021 | **+127%** | bull |
| **2022** | **+22%** | **bear (shorts earn)** |
| 2023 | −1% | recovery/chop |
| 2024 | +10% | mixed |
| 2025 | −3% | chop |

**CAGR +24%, Sharpe 0.71, maxDD −44%, worst year −3%.** Positive in the bull *and* the
bear; the two losing years are tiny (−1%, −3%). That is the all-weather signature.

### Cost sensitivity (the honesty gate)
| Cost/side | CAGR | Sharpe | 2022 | worst year |
|---|---:|---:|---:|---:|
| 6 bps | +37% | 0.92 | +30% | **+10%** (positive every year) |
| **15 bps** | **+24%** | **0.71** | **+22%** | −3% |
| 30 bps | +10% | 0.44 | +4% | −14% |
| 50 bps | +1% | 0.24 | −0% | −28% |

The all-weather property (2022 positive, smooth) holds at realistic cost (≤~20 bps)
and keeps 2022 positive even at 30 bps — far more robust than the dollar-neutral book
that collapsed at 50 bps. It **is** cost-sensitive: do not run it at 50 bps. This is a
top-30-liquid, modest-size strategy.

---

## The hedge-fund workflow (researcher → bull → bear → executor)

The spine generalises into the multi-agent architecture requested:

```
RESEARCHER   classify regime each day (causal): market-index trend + breadth
             -> BULL (idx up & breadth>0.5) / BEAR (idx down & breadth<0.5) / CHOP
BULL sleeve  long the top-k strongest-momentum coins (the long-only orchestrator)
BEAR sleeve  short the bottom-k weakest-momentum coins (crisis alpha)
EXECUTOR     route: BULL->bull, BEAR->bear, CHOP->reduced long; vol-target the book,
             cap gross, apply the graded drawdown brake; output net positions
```

**Regime book (HF workflow) + drawdown brake — the higher-return variant (OOS, 15 bps):**
- **CAGR +34%, Sharpe 0.93, maxDD −35%, Calmar 0.95, 2022 ≈ 0%.**
- Caveat: its *raw* form (no brake) has an **−85% drawdown** — the explicit regime
  switch whipsaws when it shorts into the sharp 2023 recovery. The graded drawdown
  brake (from `DRAWDOWN_CONTROL.md`) is **required** here; it rescues it to Calmar 0.95.

**Two viable spines, by preference:**
| | Pure TS-trend L/S | Regime book + brake |
|---|---|---|
| CAGR / Sharpe | +24% / 0.71 | **+34% / 0.93** |
| maxDD | −44% | **−35%** |
| 2022 | **+22%** | ~0% |
| Worst year | **−3%** | (brake-managed) |
| Complexity | **simple, robust, no brake needed** | regime logic + brake-dependent |

The **pure TS-trend book is the recommended spine** — simplest, most robust, positive
in 2022 on its own, worst year only −3%. The regime+brake book is the higher-octane
option if you accept the extra machinery and brake dependence.

---

## Live positioning (2026-05-25)
- **Researcher regime: CHOP** (breadth 0.45 — slightly more coins below trend than above).
- **TS-trend spine: net −44% (short-leaning), gross 100%** — currently defensive.
  - Top shorts: LTC −9%, ADA −7%, XLM −7%, BCH −7%, AAVE −7%.
  - Top longs: TRX +15%, ATOM +3%, NEAR +3%, ZEC +2%, ALGO +2%.

The spine has dynamically tilted short into the current weak tape — exactly the
behaviour that earns in a developing bear.

---

## Why this is the all-weather spine (and how it fits the product)
- **It earns in every regime via direction, not prediction:** long confirmed uptrends,
  short confirmed downtrends, small in chop. No forecast required — it follows.
- **Crisis alpha:** the short sleeve is the thing long-only and dollar-neutral both
  lacked; it turns 2022 from a −38% bleed into a +22% gain.
- **Vol-weighting defuses the corpse/short-blowup risk:** collapsing names get
  near-zero weight, so the bear P&L is the broad downtrend, not a few -100% shorts
  (and not the concentration disease — it's spread across the book).

**Product shape:** run the **TS-trend L/S book as the all-weather core (spine)**, and
optionally layer the **long-only momentum orchestrator (`MOMENTUM_ORCHESTRATOR.md`) as
a bull-beta overlay** sized small — the orchestrator adds bull-year upside (+45% CAGR)
but bleeds 2022, while the spine protects the bear. They are complementary: spine for
all-weather survival, overlay for bull amplification.

## Honest caveats
- **Cost-sensitive** — best at ≤20 bps; degrades by 30 bps; gone at 50 bps. Trade
  top-30 liquidity at modest size; this is not a high-frequency strategy.
- **Modest return** — ~24–37% CAGR is the *price* of all-weather: you give up the
  long-only bull-harvest (+45–100%) in exchange for bear protection and a −3% worst
  year. There is no free lunch; all-weather means lower, smoother, not higher.
- **maxDD −44%** for the pure spine (shorts get squeezed in sharp bear rallies). The
  drawdown brake reduces it but, for the pure spine, also cuts the 2022 gain — so the
  pure spine is best run *un-braked*; the regime book is the one that needs the brake.
- **Daily bars** — no intraday stops; paper-trade first; re-validate on your fills.

**Bottom line:** the all-weather spine is a **long/short time-series-trend book** —
+24% CAGR / 0.71 Sharpe OOS at 15 bps, **+22% in the 2022 crash**, worst year −3%,
positive across bull and bear. It is the first thing in this project that survives the
2022 wall by design, and it is the honest foundation for an all-weather crypto product.
