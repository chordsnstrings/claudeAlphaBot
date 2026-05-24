# Walk-forward research: finding a method with consistent OOS profit

This documents the search for an autonomous trading method that generates
consistent profit under **walk-forward** validation (rolling
in-sample/out-of-sample windows — the strategy is only ever judged on data
it never trained on). It records what was tested, what worked, what
*looked* like it worked but was an artifact, and the honest limits.

## Data

Federal Reserve H.10 daily exchange rates (1971–2026), loaded via
`pnpm --filter @trading/cli ingest:fed-rates` from the public
`datasets/exchange-rates` mirror. ~14k daily bars per pair for 8 long-history
majors (AUD, CAD, JPY, CHF, GBP, NOK, SEK, NZD vs USD) plus EUR from 1999.

Every series is oriented **XXXUSD** so backtest P&L is natively USD
(`pnl = priceMove × lotUnits`), correct and comparable across pairs.

**Data-fidelity caveat (important):** the Fed series is one rate per day, so
bars are `O=H=L=C` (no intraday high/low). This is fine for **wide-stop,
close-based** strategies (momentum) but makes **tight-stop** strategies
(mean-reversion) untrustworthy — an intrabar wick through a tight stop is
invisible; the stop only triggers if the *close* is beyond it. See
"What didn't survive scrutiny" below.

## Methodology

`pnpm --filter @trading/cli research:walkforward` runs a true walk-forward:

- Rolling windows: `train_months` in-sample, `test_months` out-of-sample,
  stepping by `test_months`.
- **Warm-up boundary** (`TradingSystemDeps.tradingStartsAt`): bars before a
  window's start warm the indicator buffer but generate no trades; trading
  starts exactly at the window and open positions are force-closed at window
  end — so every trade is attributable to the window, with no IS/OOS leak.
- Multi-instrument: one strategy instance per pair in a single session.
- **Risk-based sizing**: each trade risks a fixed fraction of equity
  (`computeLotSize`), with a **10× per-position leverage cap** (margin
  control). N instruments × per-trade-risk is kept under the 6% total-open
  cap so the full diversified book is investable every bar.
- Friction: Pepperstone Razor profile (spread + slippage + commission).

Bugs the harness exposed and that were fixed before trusting any number:
1. HistoricalDataFeed clock-gate deadlock on weekend/holiday gaps.
2. `signal_log` FK violation on every trade.
3. P&L currency-conversion error (~150× overstatement on USD-base pairs).
4. Walk-forward warm-up/attribution leak for hold-through strategies.
5. Missing leverage cap → tight-stop strategies synthesised 50×+ leverage.

## The method: multi-horizon Time-Series Momentum (TSMOM)

`@trading/strategies/TimeSeriesMomentumStrategy`. The canonical, heavily
replicated cross-asset momentum premium (Moskowitz–Ooi–Pedersen 2012),
hardened for robustness:

- Compute the trailing return at three horizons (default 63 / 126 / 252
  trading days ≈ 3 / 6 / 12 months).
- Hold **long** only when all three are positive, **short** only when all
  three are negative, otherwise **flat** (the agreement filter — keeps the
  strategy out of choppy, trendless regimes).
- Exit on the **signal flip** (agreement breaks), not a tight price stop.
  A wide 20×ATR disaster stop bounds catastrophic gaps only.

Why this and not a tuned single lookback: multi-horizon agreement is standard
practice (Baltas–Kosowski / AQR) and reduces overfitting risk versus
optimising one parameter.

## Results (out-of-sample, walk-forward)

Single-horizon (252d) vs multi-horizon agreement, full 1975–2026 history,
0.5%/trade, 8 majors:

| Variant | Windows | OOS trades | Net OOS P&L | Profit factor | Expectancy | Profitable windows | Stitched maxDD |
|---|---|---|---|---|---|---|---|
| Single-horizon 252d, 6mo windows | 99 | 800 | +$112,928 | — | — | 50.5% | $46,753 |
| Multi-horizon agreement, 6mo windows | 99 | 1,412 | +$65,242 | 1.33 | +0.09R | 50.5% | $27,217 |
| Multi-horizon agreement, 12mo windows | 49 | 820 | +$46,949 | 1.30 | +0.17R | 51.0% | $23,986 |

The agreement filter roughly **halved the drawdown** (the consistency lever)
while keeping a positive edge.

**12-month OOS windows (matching the 12-month momentum signal) are the most
honest test of this method**, since a trend follower needs a full cycle to be
judged. Stepping the OOS window out to 12 months **roughly doubles per-trade
expectancy (+0.17R vs +0.09R) and lowers the stitched drawdown** ($23,986 vs
$27,217) while keeping profit factor (1.30) and the profitable-window fraction
(51%) in line with the 6-month run. Note: an early partial read of this run
looked like ~67% of windows were profitable; the *completed* run is 51% — the
later (2010s+) low-trend windows pulled it back down, exactly as the per-decade
story below predicts. Recording the optimistic partial here on purpose: it is a
reminder that walk-forward results must be read only after the full run.

### Robustness to the lookback parameter

A single profitable parameter setting proves nothing — it could be the one
lucky draw from a grid of losers. To check that the edge is a property of the
*method* rather than the number 252, the 12-month-window walk-forward was re-run
at three lookbacks bracketing the default (the mid/short horizons scale with
it: `lookbackBars / 2` and `/ 4`). All three use an **identical 540-day warmup**
(`--warmup-days 540`) so even the 315-bar lookback is fully warm at every
window's trading start — an apples-to-apples comparison.

| Lookback (long/mid/short) | OOS trades | Net OOS P&L | Profit factor | Expectancy | Profitable windows | Stitched maxDD |
|---|---|---|---|---|---|---|
| 189 / 95 / 47  | 825 | +$41,850 | 1.26 | +0.16R | 51.0% | $27,203 |
| 252 / 126 / 63 | 826 | +$39,711 | 1.25 | +0.15R | 51.0% | $28,390 |
| 315 / 158 / 79 | 807 | +$46,767 | 1.30 | +0.19R | 55.1% | $28,951 |

The edge is **not a knife-edge at 252**: net P&L stays +$40–47k, profit factor
1.25–1.30, expectancy +0.15–0.19R, and the profitable-window fraction 51–55%
across a ±25% perturbation of the lookback. That parameter insensitivity is the
strongest single piece of evidence that the OOS edge is real, not curve-fit.

**An honest path-sensitivity caveat.** The friction model samples spread from a
seeded Gaussian on *every* bar (`sampleSpread` → `rng.nextNormal`), so changing
the warmup length changes how far the RNG has advanced by the time trading
starts. Identical signals therefore fill at slightly different prices, and those
differences cascade through stop/target timing. Concretely, the 252-bar run nets
**+$46,949 at 420-day warmup but +$39,711 at 540-day warmup** — same signals,
~15% different P&L. This is *not* an in/out-of-sample leak (the first window is
byte-identical across warmups, confirming signals are warmup-independent); it is
ordinary Monte-Carlo friction noise. The qualitative verdict — profit factor
>1.2, ~51% profitable windows, positive expectancy — is stable to it. The
headline-table rows are reported at the committed default 420-day warmup; the
robustness table above is internally consistent at 540.

### The honest regime story (multi-horizon, per decade)

```
1970s: +$23,137   1980s: +$39,311   1990s: +$9,920   2000s: +$15,697
2010s:  -$17,575   2020s:  -$5,249
```

FX trend-following was robustly profitable for **four straight decades
(1975–2009)** then **lost money 2010–2024** — the well-documented compression
of FX trends by post-GFC central-bank intervention. This is real, not a bug.

## What didn't survive scrutiny

- **Naive trend-following (§10.3, tight 3×ATR stop + fixed target):** deeply
  negative in-sample every window — the tight stop whipsaws on close-only
  data. This is what motivated the signal-flip exit (`Strategy.exitsForBar`).
- **Mean-reversion (Bollinger reversal) 2008–2026:** reported +$2.0M / 86%
  profitable — a **leverage + data-fidelity artifact**, not an edge. Tight
  stops → huge risk-based size → 50×+ leverage; and close-only bars never gap
  *through* the tight stop. Even capped at 10× it stayed implausible (+$472k,
  88% win rate). **Verdict: cannot be honestly backtested on close-only daily
  data.** Validating mean-reversion needs intraday high/low (e.g. real
  Dukascopy OHLC — blocked in this environment).

## Conclusion

The validated, trustworthy method is **multi-horizon time-series momentum on
FX majors**, risk-sized and leverage-capped. It shows a genuine, persistent
out-of-sample edge (profit factor 1.3, positive expectancy, net positive
over 50 years across 1,400+ OOS trades) and is *consistently* profitable
across the 1975–2009 era, with a documented, honest underperformance in the
2010s low-trend regime. The edge **survives a ±25% perturbation of the lookback**
(profit factor 1.25–1.30 across 189/252/315-bar settings), which is the
clearest sign it is a real property of the method rather than a curve-fit
parameter.

It is profitable in walk-forward back-test; "consistent" holds strongly
long-run and across most regimes but is regime-dependent in the last 15 years.
A cross-regime complement (mean-reversion / carry) is the natural next step
but requires higher-fidelity data (intraday OHLC, interest-rate differentials)
than the Fed daily series provides.

### Reproduce

```bash
DATABASE_URL=$DEV_DB pnpm --filter @trading/cli ingest:fed-rates
DATABASE_URL=$DEV_DB pnpm --filter @trading/cli research:walkforward \
  --strategy tsmom \
  --instruments AUDUSD,CADUSD,JPYUSD,CHFUSD,GBPUSD,NOKUSD,SEKUSD,NZDUSD \
  --from 1975-01-01 --to 2026-05-01 --train-months 36 --test-months 12

# Lookback-robustness sweep (identical 540-day warmup so 315 is fully warm):
for LB in 189 252 315; do
  DATABASE_URL=$DEV_DB pnpm --filter @trading/cli research:walkforward \
    --strategy tsmom \
    --instruments AUDUSD,CADUSD,JPYUSD,CHFUSD,GBPUSD,NOKUSD,SEKUSD,NZDUSD \
    --from 1975-01-01 --to 2026-05-01 --train-months 36 --test-months 12 \
    --warmup-days 540 --params "{\"lookbackBars\":$LB}"
done
```
