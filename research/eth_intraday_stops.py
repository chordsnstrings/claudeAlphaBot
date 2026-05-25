"""Untested lever: daily ETH momentum signal executed on 1h bars with an INTRADAY
trailing stop. The daily close-to-close backtest never models a stop that cuts a
crash day short, so it understates what a real futures bot can do: an intraday stop
caps the catastrophic days, which (a) removes liquidation and (b) may permit higher
leverage -> higher CAGR / more +20% months. Fully causal, walk-forward-free here
(the signal itself is the already-validated tsmom_blend; we only change EXECUTION).

Method:
  * daily signal w_d = tsmom_blend long-only, inverse-vol target (the §18.1 winner),
    decided at daily close, applied to the NEXT day's 1h bars (no look-ahead).
  * total intraday exposure E = clip(m * w_d, 0, CAP).
  * within each UTC day: compound 1h returns at exposure E; track the position's
    intraday peak; if it draws down >= STOP from that peak, go flat for the rest of
    the day (causal). Re-enter next day per the new signal.
  * costs: taker bps on entry/exit + each stop event; per-bar funding.
Compare monthly distribution vs the no-stop daily execution.
"""
from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd

from strategies import sig_tsmom_blend, build_weights
from engine import realized_vol

HERE = os.path.dirname(os.path.abspath(__file__))
INTRADAY_DIR = os.path.join(HERE, "data", "intraday")
TXN = 0.0006
FUND_H = 0.0001 / 24.0
CAP = 6.0
LBS = (10, 30, 60, 120)


def load_1h() -> pd.Series:
    df = pd.read_csv(os.path.join(INTRADAY_DIR, "ETH_1h.csv"))
    idx = pd.to_datetime(df["timestamp_ms"], unit="ms", utc=True).dt.tz_localize(None)
    p = pd.Series(df["close"].astype(float).values, index=idx)
    return p[~p.index.duplicated(keep="first")].sort_index()


def daily_exposure(close_1h: pd.Series, m: float) -> pd.Series:
    """Per-UTC-day target exposure from the daily tsmom_blend signal (causal)."""
    daily = close_1h.resample("1D").last().dropna()
    raw = sig_tsmom_blend(daily, {"lbs": LBS})
    w = build_weights(daily, raw, dict(vol_target=0.6, vol_lb=20, max_lev=3.0, long_only=True))
    e = (m * w).clip(0.0, CAP)
    # signal at close of day D applies to day D+1 -> shift by one day
    return e.shift(1).dropna()


def simulate(close_1h: pd.Series, m: float, stop: float | None) -> pd.Series:
    """Return per-UTC-day strategy returns under intraday execution (optional stop)."""
    r_h = close_1h.pct_change()
    e_day = daily_exposure(close_1h, m)
    day_key = close_1h.index.normalize()
    out = {}
    prev_exp = 0.0
    for day, e in e_day.items():
        mask = day_key == day
        rs = r_h[mask].values
        if len(rs) == 0:
            continue
        eq = 1.0
        peak = 1.0
        active = e
        stopped = False
        # entry turnover cost (change from prior day's ending exposure)
        cost = TXN * abs(active - prev_exp)
        for rh in rs:
            if np.isnan(rh):
                continue
            if stopped:
                continue
            step = 1.0 + active * rh
            if step <= 0.0:
                eq = 0.0
                break
            eq *= step
            cost += FUND_H * abs(active)
            peak = max(peak, eq)
            if stop is not None and eq / peak - 1.0 <= -stop:
                stopped = True
                cost += TXN * abs(active)   # exit turnover
                active = 0.0
        day_ret = eq - 1.0 - cost
        out[day] = day_ret
        prev_exp = active
    s = pd.Series(out).sort_index()
    s.index = pd.to_datetime(s.index)
    return s


def monthly(daily_ret: pd.Series) -> pd.Series:
    eq = (1.0 + daily_ret).cumprod()
    me = eq.resample("1ME").last().dropna()
    return me.pct_change().dropna()


def stats(mr: pd.Series):
    a = mr.values
    comp = float(np.prod(1.0 + a))
    n = len(a)
    cagr = comp ** (12.0 / n) - 1.0 if comp > 0 and n else -1.0
    return dict(n=n, mean=a.mean(), median=float(np.median(a)), std=a.std(ddof=0),
                pct20=float((a >= 0.20).mean()), worst=a.min(), best=a.max(),
                ruin=int((a <= -0.999).sum()), cagr=cagr)


def main(argv):
    p = load_1h()
    print(f"ETH 1h {p.index[0].date()}->{p.index[-1].date()}  intraday-stop execution test\n")
    print(f"{'mode':>22} {'m':>3} {'%mo>=20%':>8} {'median':>7} {'worst':>7} "
          f"{'ruinMo':>7} {'CAGR':>7}")
    rows = []
    for m in (1, 2, 3, 5, 8):
        # baseline: no intraday stop (daily close-to-close equivalent via 1h compounding)
        base = stats(monthly(simulate(p, m, None)))
        print(f"{'no-stop':>22} {m:>3} {base['pct20']:>8.0%} {base['median']:>7.0%} "
              f"{base['worst']:>7.0%} {base['ruin']:>5}/{base['n']} {base['cagr']:>7.0%}")
        for stop in (0.10, 0.15, 0.25):
            s = stats(monthly(simulate(p, m, stop)))
            print(f"{'stop '+str(int(stop*100))+'%':>22} {m:>3} {s['pct20']:>8.0%} "
                  f"{s['median']:>7.0%} {s['worst']:>7.0%} {s['ruin']:>5}/{s['n']} {s['cagr']:>7.0%}")
            rows.append((m, stop, s))
        print()
    # best by CAGR among sane (no ruin)
    sane = [r for r in rows if r[2]["ruin"] == 0]
    if sane:
        b = max(sane, key=lambda r: r[2]["cagr"])
        print(f"BEST sane (no ruin): m={b[0]} stop={int(b[1]*100)}%  CAGR={b[2]['cagr']:+.0%}  "
              f"%mo>=20%={b[2]['pct20']:.0%}  median month={b[2]['median']:+.0%}  worst={b[2]['worst']:+.0%}")
    print("\n(2020-05->2026; intraday stops on the daily tsmom_blend signal.)")


if __name__ == "__main__":
    main(sys.argv[1:])
