"""High-leverage BTC/ETH day-trading model + 'return principal fast, play house money'.

Honest framing: 'consistent 20-30%/month at 10-20x' is survivorship bias -- nobody
compounds that; a 5-10% adverse move liquidates a 10-20x position. This quantifies the
REAL distribution: best long/short momentum signal on BTC/ETH, executed on 1h bars with
(a) realistic LIQUIDATION (any 1h move <= -1/m wipes a long; >= +1/m wipes a short) and
(b) an intraday trailing stop, across 5x-20x. Then it models the user's actual edge --
the withdrawal rule -- via Monte Carlo:

  start $P; each month apply a leveraged monthly return (reset each month for the
  distribution); once equity >= 2P, WITHDRAW the principal P (record the month), then
  trade only the house money; a liquidation month (-100%) ends that path in RUIN.

Reports, per leverage: monthly %>=20/30/50, median, worst, liquidation-month rate; and
P(return principal before ruin), median months-to-return, P(ruin), expected withdrawn.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
INTRADAY = os.path.join(HERE, "data", "intraday")
RESULTS = os.path.join(HERE, "results")
TXN = 0.0006
LBS = (10, 30, 60, 120)
ANN = 365.0


def load_1h(sym):
    df = pd.read_csv(os.path.join(INTRADAY, f"{sym}_1h.csv"))
    idx = pd.to_datetime(df["timestamp_ms"], unit="ms", utc=True).dt.tz_localize(None)
    return pd.Series(df["close"].astype(float).values, index=idx).sort_index()


def daily_signal(close_1h):
    """Long/short daily momentum (tsmom_blend sign avg in [-1,1]); applied next day."""
    daily = close_1h.resample("1D").last().dropna()
    sig = sum(np.sign(daily / daily.shift(L) - 1.0) for L in LBS) / len(LBS)
    return sig.shift(1).dropna()                     # decided at close, applied next day


def daily_returns_levered(close_1h, m, stop):
    """Per-UTC-day return at leverage m with intraday trailing stop + liquidation.
    Reset each day (exposure from the daily signal). Returns Series of daily returns;
    a liquidated day = -1.0 (account would be wiped if running a live path)."""
    r_h = close_1h.pct_change()
    sig = daily_signal(close_1h)
    day_key = close_1h.index.normalize()
    out = {}
    liq_days = {}
    for day, e_sig in sig.items():
        mask = day_key == day
        rs = r_h[mask].values
        if len(rs) == 0:
            continue
        E = m * float(e_sig)                          # signed exposure, in [-m, m]
        if E == 0:
            out[day] = 0.0; liq_days[day] = False; continue
        eq, peak, stopped, liq = 1.0, 1.0, False, False
        for rh in rs:
            if np.isnan(rh):
                continue
            if stopped:
                continue
            step = 1.0 + E * rh
            if step <= 0.0:                            # intra-hour liquidation
                eq = 0.0; liq = True; break
            eq *= step
            peak = max(peak, eq)
            if eq / peak - 1.0 <= -stop:               # trailing stop -> flat rest of day
                stopped = True
        cost = TXN * abs(E) * (2 if stopped else 1)    # entry (+exit if stopped)
        out[day] = (eq - 1.0 - cost) if not liq else -1.0
        liq_days[day] = liq
    s = pd.Series(out).sort_index(); s.index = pd.to_datetime(s.index)
    return s, pd.Series(liq_days).sort_index()


def monthly(daily):
    """Compound daily->monthly, but a liquidation day (-1) makes that month -100%."""
    out = {}
    for (y, mo), grp in daily.groupby([daily.index.year, daily.index.month]):
        if (grp <= -0.999).any():
            out[(y, mo)] = -1.0
        else:
            out[(y, mo)] = float((1 + grp).prod() - 1)
    return pd.Series(out)


def withdraw_sim(monthly_rets, n_paths=20000, horizon=36, seed=1):
    """Monte Carlo the withdrawal rule. Bootstrap monthly returns; withdraw principal
    once equity>=2x; ruin if equity<=0.05. Returns summary stats."""
    rng = np.random.default_rng(seed)
    vals = monthly_rets.values
    vals = vals[~np.isnan(vals)]
    returned, ruined_before, ruined_ever, months_to_return, house = 0, 0, 0, [], []
    for _ in range(n_paths):
        eq, got_principal, dead = 1.0, False, False
        draws = rng.choice(vals, size=horizon, replace=True)
        for mth, r in enumerate(draws, 1):
            eq *= (1.0 + r)
            if eq <= 0.05:
                dead = True
                if not got_principal:
                    ruined_before += 1
                ruined_ever += 1
                break
            if not got_principal and eq >= 2.0:
                got_principal = True
                months_to_return.append(mth)
                eq -= 1.0                                # withdraw principal
        if got_principal:
            returned += 1
            house.append(max(eq, 0.0))
    n = n_paths
    return dict(
        p_return_principal=round(returned / n, 3),
        median_months_to_return=int(np.median(months_to_return)) if months_to_return else None,
        p_ruin_before_return=round(ruined_before / n, 3),
        p_ruin_ever=round(ruined_ever / n, 3),
        median_house_money_after_return=round(float(np.median(house)), 2) if house else 0.0,
    )


def main(argv):
    btc, eth = load_1h("BTC"), load_1h("ETH")
    print(f"BTC/ETH 1h {btc.index[0].date()}->{btc.index[-1].date()}")
    print("Long/short daily momentum signal, executed on 1h bars with intraday trailing")
    print("stop + realistic liquidation. Monthly distribution per leverage (reset each mo):\n")
    out = {}
    stop = 0.15
    print(f"  {'lev':>4} {'medMo':>7} {'%>=20':>6} {'%>=30':>6} {'%>=50':>6} "
          f"{'worst':>7} {'liqMo%':>7} {'CAGR*':>8}")
    monthly_by_lev = {}
    for m in (5, 8, 10, 15, 20):
        # 50/50 BTC+ETH book daily returns
        db, lb = daily_returns_levered(btc, m, stop)
        de, le = daily_returns_levered(eth, m, stop)
        idx = db.index.union(de.index)
        book = (0.5 * db.reindex(idx).fillna(0) + 0.5 * de.reindex(idx).fillna(0))
        # if either coin liquidates a day, treat book day as severe (-0.5..); keep simple: book avg
        mr = monthly(book)
        monthly_by_lev[m] = mr
        a = mr.values; a = a[~np.isnan(a)]
        liq_rate = float((a <= -0.999).mean())
        comp = float(np.prod(1 + a))
        cagr = comp ** (12.0 / len(a)) - 1 if comp > 0 else -1.0
        print(f"  {m:>3}x {np.median(a):>6.0%} {(a>=0.20).mean():>6.0%} {(a>=0.30).mean():>6.0%} "
              f"{(a>=0.50).mean():>6.0%} {a.min():>7.0%} {liq_rate:>6.0%} {cagr:>8.0%}")
        out[f"{m}x"] = dict(median=float(np.median(a)), pct20=float((a>=0.20).mean()),
                            pct30=float((a>=0.30).mean()), pct50=float((a>=0.50).mean()),
                            worst=float(a.min()), liq_month_rate=liq_rate, cagr=cagr,
                            n_months=len(a))
    print("\n* CAGR is the compounded path IF you never withdrew and never got liquidated "
          "to zero in sequence (optimistic; reset-month distribution).")

    print(f"\n{'='*78}\nWITHDRAWAL MODEL — 'return principal once equity>=2x, then house money'")
    print("Monte Carlo (20k paths, 36-month horizon), bootstrapped from monthly returns:")
    print(f"  {'lev':>4} {'P(returnPrincipal)':>18} {'medMonths':>10} {'P(ruinB4return)':>15} "
          f"{'P(ruinEver)':>12} {'medHouse$':>10}")
    for m in (5, 8, 10, 15, 20):
        w = withdraw_sim(monthly_by_lev[m])
        out[f"{m}x"]["withdrawal"] = w
        mm = w["median_months_to_return"]
        print(f"  {m:>3}x {w['p_return_principal']:>18.0%} {str(mm):>10} "
              f"{w['p_ruin_before_return']:>15.0%} {w['p_ruin_ever']:>12.0%} "
              f"{w['median_house_money_after_return']:>9.2f}x")
    json.dump(out, open(os.path.join(RESULTS, "leverage_btc_eth_results.json"), "w"),
              indent=2, default=str)
    print(f"\nwrote {os.path.join(RESULTS,'leverage_btc_eth_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
