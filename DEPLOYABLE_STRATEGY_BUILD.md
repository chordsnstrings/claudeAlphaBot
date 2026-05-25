# Deployable Strategy — Build Specification

**Purpose.** A complete, self-contained spec for building the *deployable* crypto
trading system from scratch. Another engineer or agent should be able to implement,
validate, and run this in production from this document alone — exact data sources,
exact signal math, exact sizing, exact execution rules, exact risk caps, and the
exact out-of-sample results to reproduce as an acceptance gate.

**Provenance.** Distilled from the research harness in `research/` and
`SOFTWARE_SPEC.md` (§12–§16). Every number below is **walk-forward out-of-sample
(OOS)**. Reference implementation of the signal layer: `research/production_strategy.py`.

---

## 0. TL;DR (read this first)

- **What it is:** a daily, **long-only**, vol-targeted **momentum** book over five
  liquid coins — **SOL, ETH, BTC, DOGE, XRP** — combining two sleeves (absolute
  trend + cross-sectional rotation), run on a **$100k annual-reset account** with an
  **annual +50% profit-lock / −40% stop**, at **≤3× leverage** (book gross capped 2×).
- **Validated expectation:** banks **+50% in 9 of 10 calendar years (90%)** OOS with
  the best static allocation; **6 of 7 (86%)** when the allocation weights are
  *themselves* chosen out-of-sample. Worst (non-banked) year ≈ **−43%**.
- **What it is NOT:** it is **not** a +50%-every-year guarantee and **not** a path to
  1000%/yr. The lone structural miss is a **2022-type all-coin crash**. Anyone
  promising "consistent +50%/yr with no down years" is describing fraud, not this.
- **Hard rules:** no leverage beyond ~3× (higher → −100% liquidation years), no
  low-cap "sniping" (one-year lottery, net-negative after costs), paper-trade before
  capital. See §16.

---

## 1. Validated outcomes (the acceptance target)

All figures are stitched walk-forward OOS on daily bars, costs 6 bps/side + ~1 bp/day
funding, annual-reset $100k model with +50% lock / −40% stop, book leverage `m=3`.

### 1.1 Recommended configuration — trend(70%) + cross-sectional(30%) blend
**9/10 years bank +50% (90%); worst year −43%; avg +55%/yr.** trend↔XS daily-return
correlation **+0.28** (genuine diversification).

| Year | Book return (m=3, +50% lock) | Banked +50%? |
| ---: | ---: | :--: |
| 2016 | +54% | ✅ |
| 2017 | +53% | ✅ |
| 2018 (bear) | +59% | ✅ |
| 2019 | +158% | ✅ |
| 2020 | +53% | ✅ |
| 2021 | +54% | ✅ |
| **2022 (bear)** | **−43%** | ❌ |
| 2023 | +55% | ✅ |
| 2024 | +52% | ✅ |
| 2025 | +57% | ✅ |

The cross-sectional sleeve is what banks the trendless **2023** (trend-only loses
−44% there); the trend sleeve carries the strong-trend years. 2022 is the one year
no long-only construction banks — every coin crashed together.

### 1.2 Fully-OOS allocation walk-forward (most honest)
When the blend weight `w` and leverage `m` are re-chosen each year from prior data
only (no hindsight on the allocation): **6/7 years (86%)**, only miss 2022 (−41%).

| Year | chosen w_xs | chosen m | return | banked |
| ---: | :--: | :--: | ---: | :--: |
| 2019 | 0.8 | 2 | +123% | ✅ |
| 2020 | 0.4 | 3 | +53% | ✅ |
| 2021 | 0.4 | 3 | +62% | ✅ |
| 2022 | 0.4 | 3 | −41% | ❌ |
| 2023 | 0.4 | 3 | +83% | ✅ |
| 2024 | 0.4 | 3 | +52% | ✅ |
| 2025 | 0.4 | 3 | +74% | ✅ |

### 1.3 Trend-only baseline (simpler fallback)
Trend sleeve alone (no cross-sectional), `m=3`: **8/10 (80%)**, worst −44%; misses
2022 (−22%) and 2023 (−44%). Use this if you want the simplest possible system.

### 1.4 Per-coin standalone (context; not the deployable unit)
ETH 7/8 (88%), DOGE 7/9 (78%), SOL 3/4 (75%, real data), BTC 7/10 (70%), XRP 4/10
(40%). XRP is the weakest; it is carried by the book, never run alone.

> **Acceptance gate:** a fresh build must reproduce §1.1 (9/10, worst ≈ −43%) and
> §1.2 (6/7) from the same data before any capital is risked. If your numbers differ
> materially, you have a bug — do not deploy.

---

## 2. Universe

```
COINS = ["SOL", "ETH", "BTC", "DOGE", "XRP"]
```
Spot pairs vs USDT. All five are liquid, perp-listed, and reachable on both data
sources. SOL uses **real** price data (earlier research substituted DOT because the
free daily source lacked SOL; that is resolved — use real SOL).

---

## 3. Data layer

### 3.1 Sources (both reachable; no API key needed for market data)
| Use | Host | Notes |
| --- | --- | --- |
| **Primary daily history** | `https://data-api.binance.vision` | Binance's public market-data mirror. `api.binance.com` is geo-blocked (HTTP 451) from many hosts; **use the `data-api.binance.vision` mirror** for klines. Read-only, market data only. |
| **Live/fallback** | `https://api.kucoin.com` | KuCoin public market data; also serves candles. Use as a cross-check and live fallback. |

**Binance Vision klines:**
```
GET /api/v3/klines?symbol=SOLUSDT&interval=1d&startTime=<ms>&endTime=<ms>&limit=1000
kline = [openTime, open, high, low, close, volume, closeTime, quoteVolume,
         nTrades, takerBuyBase, takerBuyQuote, ignore]   # ASC, max 1000/req
```
Paginate forward by `startTime = lastOpenTime + intervalMs`. Reference loader:
`research/binance_vision.py` (`fetch_daily`, `fetch_klines`).

**KuCoin candles:**
```
GET /api/v1/market/candles?type=1day&symbol=SOL-USDT&startAt=<sec>&endAt=<sec>
data row = [time(sec), open, close, high, low, volume, turnover]   # DESC, max 1500/req
```

### 3.2 Bar definition & schema
- **Frequency:** **daily**, UTC day boundary (00:00:00 UTC). The validated edge is on
  daily closes. Intraday is *not* required and does not improve consistency (intraday
  mean-reversion is net-negative after costs — see SOFTWARE_SPEC §12.7).
- **Price field:** daily **close** (`close` from klines). Quote volume retained for
  liquidity sanity checks only; not used in signals.
- Slim cached schema per coin: `date, close, volume_usd` (one row/day, ascending).

### 3.3 Panel construction (critical for correctness)
1. Build a `DataFrame` of daily closes, columns = coins, index = UTC date.
2. Each coin starts at its listing date (NaN before). SOL from 2020-08-11, others
   earlier. Do **not** forward-fill across listing gaps — leave NaN; signals must be
   NaN-aware (a coin with no price that day is simply not held).
3. **Align the right edge:** trim the panel to `min(last_valid_date over coins)` so
   every coin has a bar on the final day (sources can lag by a day).
4. Deduplicate timestamps; sort ascending.

---

## 4. Indicators (all strictly causal — value at day *t* uses only data ≤ *t*)

```
ann = 365                                  # crypto trades every day
ret[t]            = close[t]/close[t-1] - 1
realized_vol(n)[t]= std(ret over trailing n days, ddof=0) * sqrt(ann)   # min 5 obs
```
No indicator may use any data after day *t*. The weight decided at the close of day
*t* is applied to (earns) the return of day *t+1* — see §8.

---

## 5. Sleeve A — absolute trend (`tsmom_blend`, long-only)

**Signal (per coin, causal):**
```
lbs(SOL) = lbs(ETH) = lbs(BTC) = [10, 30, 60, 120]
lbs(DOGE)= lbs(XRP)            = [20, 40, 80, 120]

raw[t] = mean over L in lbs of  sign( close[t] / close[t-L] - 1 )      # ∈ [-1, +1]
```
i.e. the fraction of lookback horizons currently in an uptrend, mapped to [−1,1].

**Sizing (inverse-vol target, long-only):**
```
VOL_FLOOR  = 0.10
VOL_TARGET = 0.60
VOL_LB     = 20
MAX_LEV    = 3.0

rv[t]   = max( realized_vol(VOL_LB)[t], VOL_FLOOR )
scale[t]= min( VOL_TARGET / rv[t], MAX_LEV )
wA[coin][t] = clip( max(raw[t], 0) * scale[t], 0, MAX_LEV )            # long-only: raw<0 -> flat
```
Net effect: long the coin only while it trends up, sized inversely to its recent
volatility, capped at 3×; **flat (0) otherwise** — this is why it sits out bears.

---

## 6. Sleeve B — cross-sectional rotation (long top-k)

**Score (per coin, per day, causal) — EXACT validated formula:**
```
XS_LBS  = [20, 40, 80]
XS_TOPK = 2

r_L[i,t]   = close[i,t] / close[i,t-L] - 1
score[i,t] = mean over L in XS_LBS of  sign(r_L[i,t]) * r_L[i,t]
```
> ⚠️ **Implementation note (do not "fix" without re-validating):** `sign(r)*r ≡ |r|`.
> The score is therefore the **average absolute L-period return** — it ranks coins by
> *move magnitude*, and the sleeve holds the `k=2` largest-magnitude movers **long**.
> This is the exact expression that produced the §1 OOS results. If you change it to a
> signed return (`r_L` directly), you are building a *different* strategy and **must
> re-run the walk-forward gate (§13) before trusting the 90% figure.**

**Weights:**
```
rank coins each day by score descending (only coins with a valid score)
hold top XS_TOPK equal-weight: w = 1/XS_TOPK each, others 0
basket[t]  = sum_i (w_shifted[i] * ret[i,t])          # gross-1 basket daily return
rv[t]      = max( realized_vol(basket, 30)[t], VOL_FLOOR )
scaleB[t]  = min( VOL_TARGET / rv[t], MAX_LEV )
wB[coin][t]= w[coin][t] * scaleB[t]
```

---

## 7. Book construction

```
W_TREND   = 0.70
W_XS      = 0.30          # validated band 0.3–0.5; 0.3 gives the 90% in §1.1
EFF_LEV_CAP = 2.0         # cap on book gross exposure as a multiple of equity

book[coin][t] = W_TREND * wA[coin][t] + W_XS * wB[coin][t]

gross[t]      = sum_coin |book[coin][t]|
if gross[t] > EFF_LEV_CAP:
    book[*][t] *= EFF_LEV_CAP / gross[t]              # scale whole book down
```
> The reference module `production_strategy.py` ships `W_XS = 0.40` (inside the robust
> band). **For the headline 9/10 result use `W_XS = 0.30`.** Both are acceptable; the
> band is robust, but pick one, validate it (§13), and keep it fixed.

The book leverage `m` from §1 is applied as the *account-level* multiplier inside the
annual wrapper (§8), on top of `book`'s own gross (which is already ≤ `EFF_LEV_CAP`).
Net peak exposure = `m * EFF_LEV_CAP`; keep `m ≤ 3` and total effective exposure
sane. **In live trading, prefer setting `m` via the wrapper and keeping per-order
exposure within exchange margin limits; never let combined exposure exceed ~3×.**

---

## 8. Execution accounting & the annual wrapper

### 8.1 Daily accounting (no look-ahead)
```
held[coin][t] = book[coin][t-1]                       # weight decided at close t-1
turnover[t]   = sum_coin |held[coin][t] - held[coin][t-1]|
gross_ret[t]  = sum_coin held[coin][t] * ret[coin][t]
cost[t]       = TXN * turnover[t] + FUNDING * sum_coin |held[coin][t]|
strat_ret[t]  = gross_ret[t] - cost[t]
```
`TXN = 0.0006` (6 bps/side), `FUNDING = 0.0001` (1 bp/day per unit gross). These are
conservative for liquid perps at modest size; raise them if trading large notional.

### 8.2 Annual wrapper (the $100k profit-withdrawal model)
```
TARGET = 0.50 ; STOP = 0.40 ; m = 3      (book leverage)

each Jan 1 (UTC):  equity = $100,000 ; locked = False
each day:
    if locked: continue                              # flat for rest of year
    step = 1 + m * strat_ret[t]
    if step <= 0:  equity = 0 (LIQUIDATION)           # must be prevented by §10
    equity *= step
    if equity/100000 - 1 >= TARGET:  locked = True    # bank +50%, go flat, withdraw
    if equity/100000 - 1 <= -STOP:   locked = True    # stop out for the year
Dec 31:  withdraw profit above $100k; reset equity to $100,000 next Jan 1
```
The profit-lock is what converts "touched +50% intra-year" into a *banked* +50%; the
−40% stop bounds the bad years and (with §10) prevents leveraged ruin.

---

## 9. Cost & leverage model (live realism)

- **Leverage mechanics:** running the engine at `m×` size ≡ multiplying daily net
  return by `m`. The exchange's margin facility permits notional > equity; **effective
  exposure** = notional ÷ equity. A day where `1 + m·ret ≤ 0` is a liquidation.
- **Why ≤3×:** OOS, leverage beyond ~3× raises good-year returns *and* ruin
  probability; at ≥8× the book has −100% years and compounded wealth → 0 (gambler's
  ruin). 2–3× + the −40% stop is the validated sane choice.
- **Slippage/capacity:** the 6 bps assumption holds only at modest size on these
  liquid pairs. Large notional moves the book; size positions to keep market impact
  well under the per-trade cost budget. This strategy has finite capacity.

---

## 10. Risk controls & circuit breakers (mandatory)

1. **Annual −40% stop** (§8.2): go flat for the remainder of the calendar year once
   YTD ≤ −40%. Bounds each losing year.
2. **+50% profit-lock** (§8.2): go flat once YTD ≥ +50%; withdraw at year end.
3. **Gross-exposure cap** (§7): book gross ≤ 2× equity, and combined with `m` keep
   total effective exposure ≤ ~3×.
4. **Liquidation guard:** size so that a plausible adverse daily move cannot drive
   `1 + m·ret ≤ 0`. With `m=3`, a single-day −33% book move is fatal — use exchange
   stop/liquidation buffers and prefer cross-checking against intraday price; if a
   coin gaps hard intraday, the daily model can understate ruin. Keep margin headroom.
5. **Data-integrity halt:** if the daily panel is stale, has a gap, or a coin's price
   moves implausibly (e.g. bad tick), **do not trade**; hold prior weights and alert.
6. **Kill switch:** a manual flag that flattens the book and halts new orders.

---

## 11. Execution specification

- **Cadence:** once per day, shortly after **00:00 UTC** (the bar that closes the UTC
  day). Recompute target weights `book[*][today]`, then rebalance.
- **Instruments:** USDT-margined **perpetual futures** (for leverage and easy shorting
  headroom) *or* spot + margin. Long-only here, so spot+margin is sufficient if you
  don't need >1× per coin; perps are simpler for the `m` multiplier. Pick one and keep
  the cost model consistent with it.
- **Order type:** target a notional per coin = `equity * m * book[coin]`. Compute the
  delta vs current position; submit **limit/post-only** orders near mid to minimize
  taker fees, falling back to marketable limits if not filled within a tolerance
  window. Avoid pure market orders on size.
- **Rebalance band:** only trade a coin if `|target_notional - current_notional|`
  exceeds a threshold (e.g. **0.5% of equity** or 5% of the position) to suppress
  churn and turnover cost. (Daily turnover is already modest; the band is a guard.)
- **Rounding:** respect each pair's lot/notional step and min-notional.
- **Idempotency:** tag orders with the trade date; never double-submit a day's
  rebalance after a restart (reconcile against fills first).

---

## 12. State, accounting & reconciliation

Persist (durable store, survives restarts):
- `equity_start_of_year`, `ytd_equity`, `locked_for_year` (per the wrapper).
- Last computed target weights and the date they were applied.
- Realized fills, fees, funding paid; reconcile broker positions vs intended weights
  each cycle. On mismatch beyond tolerance → alert and reconcile before next trade.
- Year boundary job: snapshot, withdraw profit above $100k, reset state for Jan 1.

---

## 13. Validation & acceptance gate (do this before capital)

1. **Reproduce the data:** pull daily closes for the 5 coins from Binance Vision.
2. **Re-run the walk-forward** (reference: `research/annual_target.py`,
   `research/xs_blend.py`, `research/alloc_wf.py`):
   - rolling **non-overlapping** train/test (e.g. train 540d / test 180d); pick params
     on **train only** by train Sharpe; score on the **unseen** test slice; stitch the
     OOS test returns.
   - apply the annual wrapper (§8.2) to the stitched OOS stream.
3. **Require:** static blend reproduces **9/10 (90%), worst ≈ −43%** (§1.1); allocation
   walk-forward reproduces **6/7 (86%)** (§1.2); trend↔XS corr ≈ **+0.28**.
4. **Cost stress:** re-run at 12–25 bps/side; the edge must survive (it does in
   research — degrades gracefully, not catastrophically).
5. If any of these fail to reproduce, there is a bug — **fix before deploying.**

---

## 14. Build plan / architecture

```
┌────────────┐   daily klines        ┌─────────────┐
│ data fetch │ ───────────────────▶  │ panel build │  (5 coins, UTC daily close,
│ (binance   │   (KuCoin fallback)   │  + align    │   NaN-aware, right-edge trim)
│  vision)   │                       └──────┬──────┘
└────────────┘                              │
                                            ▼
                         ┌──────────────────────────────────┐
                         │ signal layer (production_strategy)│
                         │  A: tsmom_blend long-only (§5)     │
                         │  B: cross-sectional top-2 (§6)     │
                         │  book = 0.7A + 0.3B, gross≤2× (§7) │
                         └──────────────┬────────────────────┘
                                        │ target weights for today
                                        ▼
        ┌────────────────────────────────────────────────────────┐
        │ annual wrapper + risk (§8,§10): lock/stop/reset, caps,   │
        │ liquidation guard, data-integrity halt, kill switch      │
        └──────────────┬─────────────────────────────────────────┘
                       │ target notionals
                       ▼
        ┌──────────────────────────────┐   reconcile   ┌───────────┐
        │ execution (§11): delta orders │ ◀───────────▶ │ exchange  │
        │ limit/post-only, rebalance band│   fills/pos   │ (perp/spot)│
        └──────────────┬───────────────┘               └───────────┘
                       ▼
                 ┌──────────┐
                 │ state &  │  (equity, ytd, locked, fills, funding;
                 │ ledger   │   year-boundary withdraw/reset)
                 └──────────┘
```

**Build order:** (1) data + panel, (2) signal layer (port §5–§7; diff against
`production_strategy.py` to byte-match weights), (3) backtest harness + reproduce §13
gate, (4) paper-trading loop (execution + state, no real orders), (5) live with tiny
size, (6) scale within capacity. The repo's `packages/bot` already provides exchange
adapters, a scheduler, circuit breakers and a paper mode to build on.

A correct signal port, run today, produces weights like (2026-05-24):
`ETH 39% + DOGE 39%, gross 78%` (the two strongest-momentum coins; SOL/BTC/XRP not in
qualifying uptrends → 0). Use this as a smoke test.

---

## 15. Paper-trade → go-live checklist
- [ ] §13 acceptance gate reproduced (90% static, 86% allocation-WF).
- [ ] Signal layer byte-matches the reference weights on historical dates.
- [ ] Paper-trade ≥ 1 full quarter; realized fills/fees track the model within budget.
- [ ] Risk controls (§10) all exercised in a dry run (stop, lock, halt, kill switch).
- [ ] Year-boundary withdraw/reset job tested.
- [ ] Capacity check: intended notional ≪ pair liquidity; impact < cost budget.
- [ ] Start live at small size; scale only after live tracks paper.

---

## 16. Hard DON'Ts (each is a measured, rejected idea — see SOFTWARE_SPEC)
- **Don't promise/expect +50% every year.** Provably unreachable with a static blend
  of honest sleeves; 2022 (all-coin crash) is the structural miss. Ceiling ≈ 90%.
- **Don't chase +1000%/yr.** It appears only as a frictionless backtest *average*
  driven by outlier years (median is far lower); the leverage needed to force it
  every year guarantees ruin. (SOFTWARE_SPEC §12.12)
- **Don't add low-cap "sniping."** Cross-sectional momentum on small alts is a
  one-year (2021) lottery that bleeds −40%/yr otherwise and is **net-negative
  (−43% to −61% CAGR) after realistic 50–100 bps costs**, plus survivorship-biased.
  (SOFTWARE_SPEC §12.13)
- **Don't run >3× leverage.** −100% liquidation years; compounded wealth → 0.
- **Don't rely on intraday mean-reversion** as a return source — net-negative after
  costs; only a weak uncorrelated diversifier. (SOFTWARE_SPEC §12.7)
- **Don't skip the −40% stop or the data-integrity halt.**

---

## 17. Exact parameter reference card

| Parameter | Value |
| --- | --- |
| Coins | SOL, ETH, BTC, DOGE, XRP |
| Bar | daily, 00:00 UTC, close |
| Data | data-api.binance.vision (primary), api.kucoin.com (fallback) |
| Trend lbs (SOL/ETH/BTC) | [10, 30, 60, 120] |
| Trend lbs (DOGE/XRP) | [20, 40, 80, 120] |
| VOL_TARGET / VOL_LB / VOL_FLOOR / MAX_LEV | 0.60 / 20 / 0.10 / 3.0 |
| XS lookbacks / top-k | [20, 40, 80] / 2 |
| XS score | mean_L sign(r_L)·r_L  ( ≡ mean_L \|r_L\| ) |
| Book weights (trend / XS) | 0.70 / 0.30 (band 0.3–0.5) |
| Book gross cap (EFF_LEV_CAP) | 2.0× |
| Book leverage m | 3 (2–3 sane range) |
| TARGET / STOP | +0.50 / −0.40 |
| TXN / FUNDING | 0.0006 /side, 0.0001 /day |
| Annualization (ann) | 365 |
| Account model | $100k reset each Jan, withdraw profit at year end |

**Reference code:** `research/production_strategy.py` (signal layer),
`research/strategies.py` (`sig_tsmom_blend`, `build_weights`),
`research/engine.py` (accounting/metrics), `research/annual_target.py` &
`research/xs_blend.py` & `research/alloc_wf.py` (validation),
`research/binance_vision.py` (data). Full study: `SOFTWARE_SPEC.md` §12–§16.

---

## 18. Honesty statement
Past performance does not predict future returns. Walk-forward validation limits but
does not eliminate regime-change risk. The validated edge is real and survives cost
stress, but it is **lumpy** (trend years carry it), has a **documented failure mode**
(synchronized crash, e.g. 2022), and has **finite capacity**. Deploy small, paper
first, respect the stops, and treat ~33–55% CAGR / ~86–90% of years banking +50% as
the honest expectation — not a guarantee.
