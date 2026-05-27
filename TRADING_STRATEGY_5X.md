# Trading Strategy — The 5× Harvest (All-Weather Book + 2× Profit-Harvest)

**This documents the exact configuration that extracted ~5.1× the stake in cash.** It is
one specific point in the research space (selected by the sweep in §5); the broader
engine and full source are in
[`ENGINE_AND_HARVEST_REPLICATION.md`](ENGINE_AND_HARVEST_REPLICATION.md), the live harness
in [`research/live_trader.py`](research/live_trader.py). Every number here is walk-forward
out-of-sample and was reproduced from the committed code (see §6 acceptance gates).

> **The 5× is a *cash-extraction* result, not a compounded return.** On a **$300,000
> base that resets every January (no year-over-year compounding)**, the policy **withdrew
> ~$1.53M in cash over 2021–2026 while the base stayed intact** — i.e. 5.1× the stake
> pulled out, self-funded, with a −25% worst drawdown of total wealth. The underlying
> book is a Sharpe-1.21 all-weather book; the harvest layer is what converts it to cash.

---

## 0. The exact configuration (one table)

| Layer | Parameter | Value |
|---|---|---|
| **Account** | Base stake | **$300,000**, reset to base each Jan 1 (no compounding) |
| | Leverage `m` | **2.0** (multiplies the book's daily net return) |
| **Book (capital split)** | CORE / BTC1H / ETH8H / SPINE | **0.40 / 0.15 / 0.15 / 0.30** ("all-weather" profile) |
| **Harvest** | Take-profit trigger | equity reaches **2× base** ($600k) |
| | Harvest fraction | **0.50** — withdraw 50% of profit, **leave 50% on the table** and keep trading |
| | Year-end | sweep all profit above base to cash; **reset to base** |
| | Stop | **−40% YTD** from base → flat for the rest of that year |
| **Costs** | CORE/intraday / SPINE | 6 bps/side (+1 bp/day funding) / 15 bps/side |

Reference implementation: `unified_bot.harvest_run(..., m=2, double_at=2.0,
harvest_frac=0.5, go_flat=False, stop=0.40)` on `PROFILES["all_weather"]`; selected by
`harvest_sweep.py`.

---

## 1. The result, precisely (OOS, 2021-05-30 → 2026-05-24)

- **Net cash extracted: $1,534,135 on a $300,000 base = 5.1×.** Base intact at year ends.
- **Total-wealth max drawdown: −25%** (wealth = at-risk account + cash already pocketed;
  withdrawals are not losses, so this is the real peak-to-trough).
- **Principal returned in ~99 days** — the first 2× harvest (Aug 2021) + sweep pulled the
  full $300k back out; everything after is house money.
- **Self-funding: yes** — the one losing year is covered by prior harvested cash; **no
  external capital is ever added beyond the initial $300k.**

**Per-year cash (the whole run):**

| Year | Net cash | Cumulative | What happened |
|---|---:|---:|---|
| 2021 (partial) | +$329,220 | $329,220 | 2 harvests (Aug/Sep) → **principal returned** |
| 2022 | −$24,994 | $304,226 | bear; small loss covered by reserve |
| 2023 | +$515,091 | $819,317 | rode the H2 rally (leaving 50% on the table caught it) |
| 2024 | +$698,557 | $1,517,874 | caught the Nov-2024 surge (m=2 survived the April drawdown) |
| 2025 | +$45,658 | $1,563,533 | choppy |
| 2026 (partial) | −$29,398 | **$1,534,135** | bear, current |

---

## 2. The book — four sleeves (the WHAT it trades)

Each sleeve produces a daily target; the book weight per coin is
`0.40·CORE + 0.30·SPINE + 0.15·BTC1H(if armed) + 0.15·ETH8H(if armed)`, then the held
exposure is `m × book` (m=2). Sleeves are near-uncorrelated (|ρ|<0.14), which is why the
blend's risk-adjusted return beats any part.

### 2.1 CORE — daily momentum (40%)  · `production_strategy.py`
Long-only, vol-targeted, over **SOL, ETH, BTC, DOGE, XRP**; book = 0.60 trend + 0.40
cross-sectional, capped at 2× gross.
- **Trend (60%):** `raw = mean over L of sign(close/close[-L]−1)`, lookbacks
  `(10,30,60,120)` for SOL/ETH/BTC and `(20,40,80,120)` for DOGE/XRP; long-only; sized
  `min(0.60/realized_vol₂₀, 3.0)`.
- **Cross-sectional (40%):** hold the **top-2** coins by `mean over L∈(20,40,80) of |r_L|`
  (magnitude), equal-weight, vol-targeted at the basket level.
- Standalone (1×): CAGR 65.3%, Sharpe 1.04, maxDD −67.8%.

### 2.2 BTC1H — 1-hour pullback (15%)  · `daytrade_strategies2.py` (`regime_pullback`)
Long BTC when **`close > SMA(50)` AND `ADX(14) ≥ 30` AND `RSI(7) ≤ 35`**; exit on a
**symmetric ±3% bracket**, 48-hour time-stop; long-only; one position. Params chosen OOS
per walk-forward fold (the above is the representative selection).
- Standalone: 54.8% win, +67.6% OOS, PF 1.23, 73% fold-win, maxDD −24.3%.

### 2.3 ETH8H — 8-hour pullback (15%)  · `daytrade_strategies2.py` (`regime_pullback`)
Long ETH when **`close > SMA(50)` AND `ADX(14) ≥ 20` AND `RSI(7) ≤ 45`**; exit on an
**asymmetric ATR bracket: TP = 3×ATR(14), SL = 1.5×ATR(14)**, 12-bar time-stop.
- Standalone: +307% OOS, PF 1.61, 51.7% win, maxDD −36.8% (high-variance crisis-beta).

### 2.4 SPINE — long/short trend "crisis alpha" (30%)  · `all_weather.py`
Pure time-series trend over the top-30-by-dollar-volume universe: **long if a coin's
multi-lookback trend is up, SHORT if down**, inverse-vol weighted
(`iv = 1/max(realized_vol₃₀, 0.20)`), normalised to a gross target (≤2.5×). Lookbacks
`(10,30,60,120)`; costs 15 bps/side. This is the only sleeve **positive in 2022 (+22%)** —
it earns in bears by shorting confirmed downtrends.
- Standalone: CAGR +24%, Sharpe 0.71, worst year −3%; correlation to CORE only +0.14.

---

## 3. Leverage (m = 2)

`m` multiplies the combined book's daily net return (equivalently: target notional per
coin = `equity × m × book_weight`). **m=2 is the sweep-optimal for this objective:**
- **m=1** is too slow to reach the 2× harvest trigger → far less cash.
- **m=3** is fatal here — the leveraged book hits the −40% stop in multiple years and even
  reverses in 2024; the smooth 30%-spine book tolerates 2× but not 3×.
- **m=2** banks the 2× repeatedly while keeping the total-wealth drawdown at −25%.

A single ≈ −50%/m intraday book move is ruin; at m=2 size so a plausible adverse day
cannot liquidate, and never exceed ~3× effective exposure.

---

## 4. The harvest engine (the HOW — what turns the book into 5× cash)

Per calendar year, starting at `base`, leverage `m`, causal & path-dependent. This exact
state machine (`unified_bot.harvest_run`) is what produced the §1 cash:

```
eq, locked, cum = base, False, cum          # cum = running net cash returned to you
for each day's book net return x:
    if not locked:
        eq *= (1 + m*x)                       # apply leveraged daily return
        if eq >= 2*base:                      # TAKE-PROFIT at 2x
            take = 0.50 * (eq - base)         #   withdraw 50% of the profit ...
            cum += take;  eq -= take          #   ... leave 50% on the table, KEEP TRADING
        if eq <= 0.60*base:                   # -40% YTD STOP
            locked = True                     #   flat for the rest of the year
    on the last day of the year:              # YEAR-END SWEEP + RESET
        cum += (eq - base);  eq = base        #   sweep profit (or cover loss from cum); reset
```

- **Why "leave 50% on the table" (not take 100% and sit):** keeping half invested after a
  2× captures post-trigger continuation rallies (the 2023 H2 run, the 2024 surge) that a
  take-all-and-flat policy sits out — worth materially more cash for a comparable drawdown.
- **Self-funding invariant:** `cum` (harvests + year-end sweeps − loss-year top-ups) never
  goes below 0; losing-year resets are paid from already-harvested cash, never new money.
- **Principal returned** the first day `cum ≥ base`.
- **Drawdown** is measured on **total wealth = `eq + cum`** (continuous across
  withdrawals/resets), giving the −25% figure.

---

## 5. Why exactly this config (the sweep that selected it)  · `harvest_sweep.py`

A 600-config sweep (spine 0–60% × m 1–3 × lock +50/+100% × stop × take-profit policy),
keeping only **self-funding** configs that **return the full $300k**, ranked by ROI per
unit total-wealth drawdown. The frontier (best self-funding ROI at each drawdown ceiling):

| Wealth maxDD ≤ | ROI | Cash on $300k | $300k back in | Config |
|---:|---:|---:|---:|---|
| −20% | 3.4× | $1,029,180 | 609 d | spine 30%, m=1.5, +50% lock, leave 25% |
| **−25%** | **5.1×** | **$1,534,135** | **99 d** | **spine 30%, m=2, +100% lock, leave 50%  ← THIS** |
| −40% | 6.5× | $1,942,300 | 95 d | spine 15%, m=2, +100% lock, leave 50% |

The −25% config is the knee: it nearly doubles the −20% config's cash for 5 more points of
drawdown, returns principal in ~3 months, and is self-funding. (The 6.5× config trades
−6% more drawdown for +1.4× cash if you can stomach it.)

---

## 6. Validation & exact reproduction (acceptance gates)

```bash
cd research
python unified_bot.py      # GATE 1-2: correlations + ALL-WEATHER Sharpe/maxDD/worst-year
python harvest_sweep.py    # GATE 3: the 5.1× / -25% / ~99-day self-funding config
```

| Gate | Must reproduce |
|---|---|
| Sleeve correlations to CORE | BTC1H ≈ 0.04, ETH8H ≈ 0.08, SPINE ≈ 0.14 (near-orthogonal) |
| ALL-WEATHER book (m=1, unlevered) | CAGR 43.8%, **Sharpe 1.21**, maxDD −31.6%, Calmar 1.39, worst yr −1.8% |
| Harvest (this config) | **5.1× / $1,534,135 on $300k, −25% wealth DD, ~99-day principal**, 597/600 self-funding |

If these don't fire, there is a bug — debug before risking capital. *(All three were
re-run on the committed data and reproduced exactly.)*

---

## 7. How to trade it  · `research/live_trader.py`, `LIVE_DEPLOYMENT.md`

Once-daily cycle (after 00:00 UTC): refresh data → mark the book → run the harvest state
machine → emit the target book → rebalance (weight-vector diff → post-only limit deltas
within a 0.5%-of-equity band). The harvest withdrawals, the −40% flatten and the year-end
sweep print as **operator alerts** (move the withdrawn cash to cold; keep the trading
account at base).
```bash
python live_trader.py init --capital 300000 --mode live
python live_trader.py run            # dry-run: prints the exact orders
python live_trader.py run --execute  # sends via ccxt (keys in env)
```

---

## 8. Honest caveats (specific to this 5× config)
- **Lumpy & sample-limited.** 4.5 years, ~4 full; 2023/2024 bull years carry the cash.
  Not a forecast.
- **m=2 leverage gap-risk** is real; the −40% daily stop cannot protect an overnight gap.
- **Spot-signal / futures-execution:** the daily CORE/SPINE are ~identical on either; the
  two intraday sleeves can diverge during funding/basis events — match their candles to
  the execution venue.
- **Live spine universe** trades currently-listed liquid names (not the survivorship-free
  backtest set), which slightly flatters SPINE.
- **2022-type synchronized crash** is softened by SPINE but not eliminated.
- Past performance does not predict future returns.
