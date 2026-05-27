"""Unified orchestrator — combine the best validated edges from ALL the research into
one capital-allocated book, and validate the COMBINATION walk-forward / out-of-sample.

Sleeves (each a separately-validated edge from this repo's research line):

  CORE  — daily, long-only, vol-targeted MOMENTUM book over SOL/ETH/BTC/DOGE/XRP
          (absolute-trend 60% + cross-sectional 40%), the pre-validated deployable
          (DEPLOYABLE_STRATEGY_BUILD.md §1: banks +50% in ~9/10 yrs OOS). Reference
          signal layer: production_strategy.py. Used here as a FIXED validated config.
  BTC1H — BTC 1H ADX-gated trend pullback (DAYTRADE_BTC_ETH_WINRATE.md §4): ~55% win,
          +68% OOS, 73% fold-win, robust. The steady intraday alpha.
  ETH8H — ETH 8H ADX-gated pullback with an asymmetric ATR exit (TP 3xATR/SL 1.5xATR):
          +307% OOS, PF 1.61, high-variance. The punchy intraday alpha.

The two intraday sleeves' parameters are chosen OUT-OF-SAMPLE per fold by the rolling
walk-forward in daytrade_strategies2.py; their per-trade OOS PnL is bucketed to its
exit DATE to form a daily return stream. The orchestrator then allocates capital
across the three daily streams and we validate the combined book:

  * standalone sleeve metrics over the common window,
  * the sleeve correlation matrix  (the diversification test),
  * combined vs core-alone  Sharpe / CAGR / maxDD  (does adding the sleeves help?),
  * % of years banking +50% under the annual $100k wrapper  — both a FIXED robust
    allocation AND a fully-OOS allocation walk-forward (weights chosen on prior data).

Everything daily; costs 6 bps/side + funding (intraday sleeves already net of 6bps).

Run:  python research/unified_bot.py
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

import data as datamod
import all_weather as aw
import production_strategy as ps
from annual_target import evaluate as annual_eval
from daytrade_strategies2 import walk_forward as intraday_wf
from engine import Costs, compute_metrics

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
COSTS = Costs(txn=0.0006, funding_daily=0.0001)

# the two validated intraday sleeves (coin, timeframe, strategy name in strategies2)
INTRADAY = {"BTC1H": ("BTC", "1h", "regime_pullback"),
            "ETH8H": ("ETH", "8h", "regime_pullback")}

# all-weather long/short time-series-trend SPINE (crisis alpha — earns in bears by
# shorting confirmed downtrends; all_weather.py / ALL_WEATHER_SPINE.md). Top-30
# universe, validated at 15 bps/side.
SPINE_COST_BPS = 15
TS_GRID = [dict(lbs=lbs, gross_target=gt, max_gross=mg)
           for lbs in ((10, 30, 60, 120), (20, 50, 100), (30, 60, 120))
           for gt in (0.6, 1.0) for mg in (1.5, 2.5)]

# Risk-profile dial (capital split across sleeves). GROWTH maximises bull upside but
# bleeds bears; ALL_WEATHER adds the defensive spine — best Sharpe, ~neutralises the
# 2022/bear catastrophe (worst yr -26% -> -2%), for some CAGR give-up. Default =
# all-weather (the honest, drawdown-aware book).
PROFILES = {
    "growth":      {"CORE": 0.70, "BTC1H": 0.15, "ETH8H": 0.15, "SPINE": 0.00},
    "all_weather": {"CORE": 0.40, "BTC1H": 0.15, "ETH8H": 0.15, "SPINE": 0.30},
}
DEFAULT_PROFILE = "all_weather"
FIXED_W = PROFILES[DEFAULT_PROFILE]

# candidate allocations for the OOS allocation walk-forward (4-sleeve)
ALLOC_GRID = [
    {"CORE": 0.70, "BTC1H": 0.15, "ETH8H": 0.15, "SPINE": 0.00},   # growth (no spine)
    {"CORE": 0.55, "BTC1H": 0.15, "ETH8H": 0.15, "SPINE": 0.15},
    {"CORE": 0.40, "BTC1H": 0.15, "ETH8H": 0.15, "SPINE": 0.30},
    {"CORE": 0.25, "BTC1H": 0.15, "ETH8H": 0.15, "SPINE": 0.45},
    {"CORE": 0.40, "BTC1H": 0.20, "ETH8H": 0.20, "SPINE": 0.20},
]

# ---- wired "HARVEST" deployment policy (sweep-optimal: harvest_sweep.py) ----
# ALL-WEATHER(30% spine) book at 2x on a $300k base that RESETS each Jan (no
# compounding). Take profit when equity 2x's, leaving 50% on the table to ride;
# sweep at year end; -40% YTD stop. This is the best risk-adjusted, SELF-FUNDING
# (never needs external cash) config that returns the full $300k fast (~99 days):
# ROI ~5.1x with a ~-25% total-wealth drawdown. (`--harvest --lock-flat` = the more
# conservative take-100%-and-sit variant.)
HARVEST_PROFILE = "all_weather"      # 30%-spine book
HARVEST_M = 2.0
HARVEST_BASE = 300_000.0
DOUBLE_AT = 2.0                      # take profit when equity reaches 2x base
ANNUAL_STOP = 0.40


# --------------------------------------------------------------------- sleeve streams
def core_daily_returns() -> pd.Series:
    """Daily net return of the CORE book (multi-coin weights -> portfolio return)."""
    panel = ps.load_panel()
    book = ps.book_weights(panel)
    ret = panel.pct_change()
    held = book.shift(1).fillna(0.0)                  # weight in force during day t
    gross_ret = (held * ret).sum(axis=1)
    turn = held.diff().abs()
    turn.iloc[0] = held.abs().iloc[0]
    cost = COSTS.txn * turn.sum(axis=1) + COSTS.funding_daily * held.abs().sum(axis=1)
    r = (gross_ret - cost).fillna(0.0)
    return r.iloc[1:]                                  # drop the first (no-return) day


def intraday_daily_returns(coin: str, tf: str, strat: str):
    """Run the intraday sleeve's rolling walk-forward and bucket its OOS per-trade PnL
    to the trade's EXIT date -> a (sparse) daily return stream of the 1x sleeve."""
    r = intraday_wf(coin, tf, strat)
    if r.get("status") != "ok":
        raise RuntimeError(f"{coin} {tf} {strat}: {r.get('status')}")
    by_day: dict[pd.Timestamp, float] = {}
    for ts, ret in r["oos_dated"]:
        d = pd.Timestamp(ts).normalize()
        by_day[d] = by_day.get(d, 1.0) * (1.0 + ret)   # compound trades closing same day
    s = pd.Series({d: v - 1.0 for d, v in by_day.items()}).sort_index()
    return s, r


def spine_daily_returns() -> pd.Series:
    """All-weather L/S trend spine: stitched walk-forward OOS daily returns, extended
    with one final OOS fold (best config on the trailing 540d applied forward) so
    coverage reaches the data end rather than the last complete 180d test window."""
    px, vol = aw.load_panel()
    nets = {}
    for p in TS_GRID:
        g, tn, ex, _ = aw.build_ts_trend(px, vol, **p)
        nets[tuple(sorted(p.items()))] = aw.net_from(g, tn, ex, SPINE_COST_BPS)
    oos = aw.walk_forward(px, vol, aw.build_ts_trend, TS_GRID, SPINE_COST_BPS).sort_index()
    last = oos.index[-1]; lo = last - pd.Timedelta(days=540)
    best, bsc = None, -1e9
    for net in nets.values():
        trs = net[(net.index > lo) & (net.index <= last)]
        if len(trs) < 60:
            continue
        sd = trs.std(ddof=0); sc = trs.mean() / sd * np.sqrt(365) if sd > 0 else -9
        if sc > bsc:
            bsc, best = sc, net
    tail = best[best.index > last] if best is not None else pd.Series(dtype=float)
    return pd.concat([oos, tail]).sort_index()


def build_panel() -> tuple[pd.DataFrame, dict]:
    """Assemble the aligned daily return frame for all four sleeves over the window
    where every sleeve is live (the intraday + spine stitched OOS span)."""
    r_core = core_daily_returns()
    streams, meta = {"CORE": r_core}, {}
    for name, (coin, tf, strat) in INTRADAY.items():
        s, res = intraday_daily_returns(coin, tf, strat)
        streams[name] = s
        meta[name] = {"oos_net": res["oos_net"], "oos_win_rate": res["oos_win_rate"],
                      "oos_n_trades": res["oos_n_trades"], "trade_days": int(len(s)),
                      "fold_win_rate": res["fold_win_rate"]}
    r_spine = spine_daily_returns()
    streams["SPINE"] = r_spine
    meta["SPINE"] = {"oos_net": float((1.0 + r_spine).prod() - 1.0),
                     "trade_days": int(len(r_spine))}
    # common window = where the intraday sleeves AND the spine are all live
    istart = max(min(streams[n].index.min() for n in INTRADAY), r_spine.index.min())
    end = min(r_core.index.max(), r_spine.index.max())
    idx = r_core.loc[istart:end].index               # full daily calendar from the core
    df = pd.DataFrame({n: streams[n].reindex(idx).fillna(0.0) for n in streams})
    return df, meta


# ------------------------------------------------------------------------- combine
def weighted(df: pd.DataFrame, w: dict) -> pd.Series:
    return sum(df[k] * w.get(k, 0.0) for k in df.columns)


def met(r: pd.Series) -> dict:
    held = pd.Series(1.0, index=r.index)
    m = compute_metrics(r, held)
    return {"cagr": m.cagr, "ann_vol": m.ann_vol, "sharpe": m.sharpe,
            "sortino": m.sortino, "max_dd": m.max_dd, "calmar": m.calmar,
            "total_return": m.total_return, "n_days": m.n_days}


def worst_year(r: pd.Series) -> float:
    by = [float((1.0 + r[r.index.year == y]).prod() - 1.0)
          for y in sorted(set(r.index.year)) if (r.index.year == y).sum() >= 250]
    return min(by) if by else float("nan")


def alloc_walk_forward(df: pd.DataFrame, m_lev: float, target=0.50, stop=0.40):
    """Fully-OOS allocation: for each calendar year, pick the allocation from ALLOC_GRID
    with the best Sharpe on PRIOR-YEARS data only, apply it OOS to that year, stitch."""
    years = sorted(set(df.index.year))
    oos = pd.Series(dtype=float)
    chosen = {}
    for y in years:
        train = df[df.index.year < y]
        test = df[df.index.year == y]
        if len(train) < 200 or len(test) < 250:       # need history + a full test year
            continue
        best, best_sh = None, -1e9
        for w in ALLOC_GRID:
            sh = met(weighted(train, w))["sharpe"]
            if sh > best_sh:
                best_sh, best = sh, w
        chosen[int(y)] = best
        oos = pd.concat([oos, weighted(test, best)])
    return oos.sort_index(), chosen


def annual_report(r: pd.Series, m_lev: float):
    e = annual_eval(r, m_lev, 0.50, 0.40)
    if e is None:
        return None
    return {"m": m_lev, "banked_50": e["banked_50"], "full_years": e["full_years"],
            "hit_rate": e["hit_rate"], "avg_year": e["avg_year"],
            "worst_year": e["worst_year"], "per_year": e["per_year"]}


def harvest_run(r: pd.Series, base=HARVEST_BASE, m=HARVEST_M, double_at=DOUBLE_AT,
                stop=ANNUAL_STOP, harvest_frac=1.0, go_flat=True) -> pd.DataFrame:
    """Whole-run sim of the harvest policy. Per calendar year: start at base; compound
    m*daily; when equity >= double_at*base, withdraw `harvest_frac` of the profit. If
    go_flat, stop for the rest of the year; otherwise keep trading (leaving
    (1-harvest_frac) of the profit ON THE TABLE to ride). -stop YTD also goes flat;
    sweep remaining profit at year end. Causal & path-dependent."""
    rows, cum = [], 0.0
    for y in sorted(set(r.index.year)):
        ry = r[r.index.year == y]
        last = ry.index[-1]
        eq, locked = base, False
        for d, x in ry.items():
            ev_cash, ev = 0.0, ""
            if not locked:
                eq *= (1.0 + m * x)
                if eq <= 1e-9:
                    eq, locked, ev = 0.0, True, "LIQUIDATION"
                elif harvest_frac > 0 and eq >= double_at * base:
                    take = harvest_frac * (eq - base)
                    cum += take; ev_cash += take; eq -= take; ev = "2X-HARVEST"
                    if go_flat:
                        locked = True
                if not locked and eq <= (1.0 - stop) * base:
                    locked, ev = True, (ev or "STOP")
            if d == last:                                   # year-end settle / reset
                settle = eq - base
                if abs(settle) > 1e-9:
                    cum += settle; ev_cash += settle
                    ev = (ev + "+" if ev else "") + ("YE-SWEEP" if settle > 0 else "YE-LOSS")
                    eq = base
            rows.append((d, eq, "FLAT" if locked else "ACTIVE", ev_cash, ev, cum))
    return pd.DataFrame(rows, columns=["date", "equity", "mode", "cash", "event",
                                       "cum_cash"]).set_index("date")


def _wealth_maxdd(daily: pd.DataFrame) -> float:
    """Drawdown of total wealth = at-risk account + cash already pocketed (withdrawals
    move money to the pocket, so the wealth curve is continuous — the real drawdown)."""
    w = daily["equity"] + daily["cum_cash"]
    return float((w / w.cummax() - 1).min())


def harvest_report(df: pd.DataFrame, harvest_frac=1.0, go_flat=True):
    r = weighted(df, PROFILES[HARVEST_PROFILE])
    book_m = (1.0 + HARVEST_M * r)
    w = PROFILES[HARVEST_PROFILE]
    print(f"HARVEST POLICY — {HARVEST_PROFILE} book "
          f"(CORE {w['CORE']:.0%}/BTC1H {w['BTC1H']:.0%}/ETH8H {w['ETH8H']:.0%}/SPINE {w['SPINE']:.0%}) "
          f"at {HARVEST_M:g}x on ${HARVEST_BASE:,.0f} (annual reset, -{ANNUAL_STOP:.0%} stop)\n")

    print("  profit-taking variants (whole run, net cash on $300k base):")
    print(f"    {'variant':<34} {'net cash':>12} {'wealth maxDD':>11} {'2x-events':>10}")
    for f, gf, lbl in [(1.0, True, "take 100% at 2x, then FLAT"),
                       (1.0, False, "take 100% at 2x, keep trading"),
                       (0.5, False, "leave 50% on the table"),
                       (0.25, False, "leave 75% on the table"),
                       (0.0, False, "leave 100% (year-end sweep only)")]:
        d = harvest_run(r, harvest_frac=f, go_flat=gf)
        tot = d["cum_cash"].iloc[-1]; n = int(d["event"].str.contains("2X").sum())
        mark = "  <-- this run" if (abs(f - harvest_frac) < 1e-9 and gf == go_flat) else ""
        print(f"    {lbl:<34} ${tot:>11,.0f} {_wealth_maxdd(d):>11.0%} {n:>10}{mark}")

    pol = "take 100% then FLAT" if (harvest_frac >= 1 and go_flat) else \
        f"leave {1 - harvest_frac:.0%} on the table (keep trading)"
    print(f"\n  MONTH-ON-MONTH — {pol}:")
    daily = harvest_run(r, harvest_frac=harvest_frac, go_flat=go_flat)
    blbl = f"book m={HARVEST_M:g}"
    print(f"  {'month':<8} {'mode':<6} {blbl:>9} {'equity$':>10} {'cash out$':>11} {'cum cash$':>12}  event")
    for y in sorted(set(df.index.year)):
        dy = daily[daily.index.year == y]
        ry = r[r.index.year == y]
        for mdate in pd.date_range(ry.index[0], ry.index[-1], freq="ME").union(
                pd.DatetimeIndex([dy.index[-1]])):
            mdays = dy[(dy.index.year == mdate.year) & (dy.index.month == mdate.month)]
            if mdays.empty:
                continue
            bret = book_m[(book_m.index.year == mdate.year) & (book_m.index.month == mdate.month)].prod() - 1
            row = mdays.iloc[-1]; cash_m = mdays["cash"].sum()
            evs = "/".join(sorted({e for e in mdays["event"] if e}))
            print(f"  {mdate.strftime('%Y-%m'):<8} {row['mode']:<6} {bret:>+9.0%} "
                  f"${row['equity']:>9,.0f} {('$'+format(cash_m,',.0f')) if abs(cash_m)>1 else '—':>11} "
                  f"${row['cum_cash']:>11,.0f}  {evs}")
        print(f"  -> {y} total: cash ${dy['cash'].sum():>+12,.0f}   cumulative ${dy['cum_cash'].iloc[-1]:>12,.0f}\n")
    total = daily["cum_cash"].iloc[-1]
    print(f"WHOLE RUN {df.index[0].date()} -> {df.index[-1].date()}: net cash ${total:,.0f} "
          f"on ${HARVEST_BASE:,.0f} ({total/HARVEST_BASE:.1f}x), wealth maxDD {_wealth_maxdd(daily):.0%}. "
          f"2021/2026 partial. Leaving profit on the table rides post-2x upside but risks "
          f"giving it back (the -40% stop is vs base, so retained profit is unprotected). Not predictive.")


def main(argv):
    if "--harvest" in argv:
        lockflat = "--lock-flat" in argv          # default = recommended leave-50% @ 2x
        harvest_report(build_panel()[0],
                       harvest_frac=1.0 if lockflat else 0.5, go_flat=lockflat)
        return
    os.makedirs(RESULTS, exist_ok=True)
    print("UNIFIED ORCHESTRATOR — CORE (daily momentum) + BTC1H + ETH8H intraday + SPINE "
          "(all-weather L/S trend)\n(intraday & spine params chosen OOS per fold; daily "
          "core = fixed validated config)\n")
    df, meta = build_panel()
    win = f"{df.index[0].date()} -> {df.index[-1].date()}  ({len(df)} days, "
    win += f"{len(set(df.index.year))} calendar years)"
    print(f"Common OOS window: {win}\n")

    # ---- 1. standalone sleeve metrics over the common window ----
    print("Per-sleeve (standalone, 1x, over the common window):")
    print(f"  {'sleeve':<7} {'CAGR':>8} {'vol':>7} {'Sharpe':>7} {'maxDD':>8} {'tradeDays':>10}")
    sleeve_metrics = {}
    for s in df.columns:
        mm = met(df[s]); sleeve_metrics[s] = mm
        td = meta.get(s, {}).get("trade_days", mm["n_days"])
        print(f"  {s:<7} {mm['cagr']:>8.1%} {mm['ann_vol']:>7.1%} {mm['sharpe']:>7.2f} "
              f"{mm['max_dd']:>8.1%} {td:>10}")

    # ---- 2. correlation matrix (the diversification test) ----
    corr = df.corr()
    print("\nSleeve daily-return correlation (diversification — lower is better):")
    print(corr.round(3).to_string())

    # ---- 3. risk profiles vs core-alone, m=1 ----
    core_only = df["CORE"]
    combined = weighted(df, FIXED_W)                 # default = all-weather
    profile_books = {"CORE only": core_only,
                     "GROWTH (no spine)": weighted(df, PROFILES["growth"]),
                     "ALL-WEATHER (+30% spine)": weighted(df, PROFILES["all_weather"])}
    print("\nProfiles (m=1) — more spine = lower CAGR, higher Sharpe, smaller drawdown:")
    print(f"  {'book':<26} {'CAGR':>8} {'vol':>7} {'Sharpe':>7} {'maxDD':>8} {'Calmar':>7} {'worstYr':>9}")
    for label, r in profile_books.items():
        mm = met(r)
        print(f"  {label:<26} {mm['cagr']:>8.1%} {mm['ann_vol']:>7.1%} {mm['sharpe']:>7.2f} "
              f"{mm['max_dd']:>8.1%} {mm['calmar']:>7.2f} {worst_year(r):>9.1%}")

    # ---- 4. annual $100k wrapper: % years banking +50% ----
    print("\nAnnual $100k wrapper (+50% lock / -40% stop) — % of FULL years banking +50%:")
    print(f"  {'book / m':<22} {'banked':>8} {'hit':>6} {'avgYr':>8} {'worstYr':>9}")
    annual = {}
    alloc_oos, chosen = alloc_walk_forward(df, 3.0)
    books = {"GROWTH": weighted(df, PROFILES["growth"]),
             "ALL-WEATHER": weighted(df, PROFILES["all_weather"]),
             "alloc-WF": alloc_oos}
    for m_lev in (2.0, 3.0):
        for label, r in books.items():
            rep = annual_report(r, m_lev)
            if rep is None:
                continue
            annual[f"{label} m={m_lev}"] = rep
            print(f"  {label+' m='+str(m_lev):<22} "
                  f"{str(rep['banked_50'])+'/'+str(rep['full_years']):>8} "
                  f"{rep['hit_rate']:>6.0%} {rep['avg_year']:>8.1%} {rep['worst_year']:>9.1%}")
    print(f"\n  alloc-WF chose per year (CORE/BTC1H/ETH8H/SPINE): "
          + "  ".join(f"{y}:{w['CORE']:.0%}/{w['BTC1H']:.0%}/{w['ETH8H']:.0%}/{w.get('SPINE',0):.0%}"
                      for y, w in chosen.items()))

    # ---- 5. combined equity curve + artifacts ----
    eq = (1.0 + combined).cumprod()
    pd.DataFrame({"core": (1.0 + core_only).cumprod(), "combined": eq}).to_csv(
        os.path.join(RESULTS, "unified_bot_equity.csv"), index_label="date")
    out = {
        "window": [str(df.index[0].date()), str(df.index[-1].date())],
        "n_days": len(df), "profiles": PROFILES, "default_profile": DEFAULT_PROFILE,
        "sleeve_meta": meta, "sleeve_metrics": sleeve_metrics,
        "correlation": corr.round(4).to_dict(),
        "metrics": {"core_only": met(core_only),
                    "growth": met(weighted(df, PROFILES["growth"])),
                    "all_weather": met(weighted(df, PROFILES["all_weather"])),
                    "alloc_wf": met(alloc_oos)},
        "annual": annual, "alloc_wf_choices": chosen,
    }
    with open(os.path.join(RESULTS, "unified_bot_results.json"), "w") as f:
        json.dump(out, f, indent=2, default=float)

    # ---- 6. live orchestrator snapshot (what to trade today) ----
    panel = ps.load_panel()
    book = ps.book_weights(panel)
    w_today = book.iloc[-1]
    print(f"\nLIVE SNAPSHOT {panel.index[-1].date()} — orchestrator target "
          f"(profile '{DEFAULT_PROFILE}', split {FIXED_W}):")
    print(f"  CORE  {FIXED_W['CORE']:.0%} -> daily book: "
          + ", ".join(f"{c} {w_today[c]:.0%}" for c in ps.COINS if abs(w_today[c]) > 1e-3))
    print(f"  BTC1H {FIXED_W['BTC1H']:.0%} -> long BTC on 1H dips, close>SMA50 & ADX>=30 (±3% bracket)")
    print(f"  ETH8H {FIXED_W['ETH8H']:.0%} -> long ETH on 8H dips, close>SMA50 & ADX>=20 (TP 3xATR/SL 1.5xATR)")
    print(f"  SPINE {FIXED_W['SPINE']:.0%} -> long/short top-30 TS-trend (crisis alpha; shorts confirmed downtrends)")
    print(f"\nwrote {os.path.join(RESULTS, 'unified_bot_results.json')} and unified_bot_equity.csv")


if __name__ == "__main__":
    main(sys.argv[1:])
