# Best of Both Worlds — Regime-Routed Long/Short (researcher → bull/bear)

Goal: long-only when the market favours it, the bear-optimised short engine when it
doesn't, with a hedge-fund "researcher" that classifies the regime and routes. Built
two versions and compared them, walk-forward OOS, against the standalone engines.
Code: [`research/best_of_both.py`](research/best_of_both.py).

> **Honest framing on "predict":** a researcher cannot forecast the future. What it can
> do — and what this does — is **nowcast the regime** causally from price/breadth/volatility
> (the proxy for market sentiment), with hysteresis so it doesn't flip-flop. True
> sentiment feeds (funding, social, options skew) are not reachable in this environment.

---

## The comparison (OOS, walk-forward, 15 bps/side)

| Engine | CAGR | Sharpe | maxDD | 2022 | Worst yr |
|---|---:|---:|---:|---:|---:|
| Long-only orchestrator (bull engine) | +45% | **1.15** | −44% | **−38%** | −38% |
| **Pure L/S trend spine** (all-weather) | +24% | 0.71 | −44% | **+22%** | **−3%** |
| Hard-switch router (long bull / short bear) | +37% | 0.79 | −74% | +18% | −33% (2023) |
| Soft-blend (spine + bull-tilt long overlay) | +68%* | 1.04* | −82% | **−14%** | −29% |
| Router + drawdown brake | +25% | 0.80 | −35% | −12% | — |

\* the soft-blend's +68%/1.04 is inflated by an explosive 2021 (+1497%); its −82%
drawdown and −14% 2022 disqualify it as all-weather.

Per-year, hard-switch router: 2021 +688% · **2022 +18%** · 2023 **−33%** · 2024 +5% · 2025 **−28%**.

---

## What the data says (the honest synthesis)

**Routing to chase bull upside reintroduces the 2022 risk — there is no free lunch.**
- The **hard switch** earns in 2022 (+18%, shorts pay) but **whipsaws the transitions**:
  it is still short into the sharp 2023 recovery (−33%) and mis-routes 2025 chop (−28%),
  with a −74% drawdown. Regime-timing error costs more than the bull capture adds.
- The **soft blend** (always-on spine + a long overlay scaled by bull conviction) lifts
  CAGR but the long overlay **contaminates the bear** — 2022 flips from +22% (spine alone)
  to **−14%** — and drawdown blows out to −82%. The very long-beta that wins 2021/2024
  is what loses 2022.
- Adding the **drawdown brake** to either tames the drawdown (−35/−39%) and Sharpe
  (~0.8) but converges them to roughly the spine's risk-adjusted level while **giving
  back the clean 2022 win** (brake de-risks during the bear before the shorts pay).

**The pure per-asset long/short trend spine is the best "best of both" — done right.**
It is *already* "long when bull, short when bear," but **per asset and continuously**:
long the coins trending up (bull behaviour), short the coins trending down (crisis
alpha), with no fragile top-down regime switch to mis-time. That is why it keeps the
cleanest profile — **2022 +22%, worst year −3%, Sharpe 0.71, maxDD −44%** — while every
top-down router either whipsaws or dilutes the bear protection. The per-asset trend
*is* the researcher, implemented bottom-up and whipsaw-resistant.

---

## Recommendation

1. **Core / spine (recommended): the pure L/S trend book** (`ALL_WEATHER_SPINE.md`).
   Cleanest all-weather: long uptrenders, short downtrenders, per asset. 2022 +22%,
   worst year −3%. This already delivers "long when needed, short in the bear."
2. **If you want more bull upside (accepting more variance): the regime-routed engine
   + drawdown-brake executor** — CAGR +25%, Sharpe 0.80, maxDD −35%, Calmar 0.72. It
   gives the explicit researcher→long/short behaviour you asked for, with risk control,
   but does **not** risk-adjusted-beat the pure spine; the transition whipsaw is the price.
3. **Bull amplifier (optional, sized small): the long-only momentum orchestrator**
   (`MOMENTUM_ORCHESTRATOR.md`) — +45% CAGR in bull, but −38% in 2022, so only as a
   small satellite on top of the spine, never the core.

The honest bottom line: **you cannot get the long-only bull-harvest AND a positive
2022 from one directional dial** — the same long beta is both the upside and the bear
risk. The construction that resolves the tension is the per-asset L/S trend spine, not
a top-down regime switch. The researcher adds the most value as a *risk dial* (cut
gross / de-risk in confirmed bear + vol spike), not as a long↔short flipper.

---

## The researcher (hedge-fund workflow, causal nowcast)
```
RESEARCHER  regime = f(market-index multi-lookback trend, breadth = % coins above 50d,
            index vol percentile).  Sticky/hysteresis: flip to BULL only on trend>band
            & breadth>0.55 & not vol-spike; to BEAR on trend<-band & breadth<0.45, or
            vol-spike with weak breadth; else hold prior state.
ROUTER      BULL -> long-only orchestrator;  BEAR -> short weakest (crisis alpha);
            CHOP -> reduced long.   (or, recommended, drive the spine's gross/tilt.)
EXECUTOR    vol-target, gross cap, graded drawdown brake -> net positions.
```

**Live (2026-05-25):** researcher = **BULL (sticky)**, but breadth is only 0.45 and the
pure-spine classifier tilts net short — i.e. the tape is genuinely **ambiguous/chop**
and different classifiers disagree. This is an honest limitation: regime nowcasting is
noisiest exactly at transitions. In BULL the router would go long ZEC/NEAR/TRX/DASH/ATOM;
the spine would simultaneously be short the weak names (LTC/ADA/XLM). When the
classifiers disagree, size down — that disagreement is itself a "stay-defensive" signal.

## Caveats
- Cost-sensitive (judged 15 bps; degrades by 30 bps, gone by 50 — like all crypto L/S).
- Regime nowcasting whipsaws at transitions; hysteresis reduces but cannot remove it.
- No external sentiment data here; the researcher is price/breadth/vol only.
- Daily bars, top-30 liquidity, modest size; paper-trade first.
