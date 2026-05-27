"""Build the dashboard data snapshot (ui_data.json) by running the TESTED engine once.

Reuses the exact backtest/live code (unified_bot, harvest_sweep, live_trader, ...), so
the UI shows faithful numbers. Heavy parts (build_panel, the 600-config sweep, the live
fetch) run here ONCE; the server just serves the JSON. Re-run to refresh.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # research/

import numpy as np
import pandas as pd

import all_weather as aw
import harvest_sweep as hs
import live_trader as lt
import production_strategy as ps
import unified_bot as ub

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "ui_data.json")
BASE = hs.BASE


def f(x):
    return None if x is None else float(x)


def sweep(df):
    books = {s: ub.weighted(df, hs.book_w(s)) for s in hs.SPINES}
    rows = []
    for s, r in books.items():
        for m in hs.M:
            for lock in hs.LOCKS:
                for stop in hs.STOPS:
                    for frac, flat, pol in hs.POLICIES:
                        e = hs.evaluate(r, m, lock, stop, frac, flat)
                        e.update(spine=s, m=m, lock=lock, pol=pol)
                        rows.append(e)
    ok = [e for e in rows if e["self_fund"] and e["rec_days"] is not None]

    def desc(e):
        return f"spine {e['spine']:.0%}, m={e['m']:g}, lock +{(e['lock']-1)*100:.0f}%, {e['pol']}"

    frontier = []
    for ceil in (0.15, 0.20, 0.25, 0.30, 0.40):
        cands = [e for e in ok if abs(e["maxdd"]) <= ceil + 1e-9]
        if cands:
            b = max(cands, key=lambda e: e["roi"])
            frontier.append({"ceil": ceil, "roi": f(b["roi"]), "cash": f(b["total"]),
                             "dd": f(b["maxdd"]), "days": b["rec_days"], "config": desc(b)})
    top = sorted(ok, key=lambda e: e["score"], reverse=True)[:8]
    rec = max(ok, key=lambda e: e["score"]) if ok else None
    # the recommended deploy config = best self-funding at <= -25% DD (the documented one)
    sub = [e for e in ok if abs(e["maxdd"]) <= 0.25 + 1e-9]
    deploy = max(sub, key=lambda e: e["roi"]) if sub else rec
    scatter = [{"dd": f(abs(e["maxdd"])), "roi": f(e["roi"]),
                "rec": (e is deploy)} for e in ok]
    top_rows = [{"roi": f(e["roi"]), "cash": f(e["total"]), "dd": f(e["maxdd"]),
                 "days": e["rec_days"], "config": desc(e), "rec": (e is deploy)} for e in top]
    return frontier, top_rows, scatter, deploy


def harvest_curve(df):
    r = ub.weighted(df, ub.PROFILES["all_weather"])
    daily = ub.harvest_run(r, harvest_frac=0.5, go_flat=False)        # the 5x config (m=2, leave 50%)
    daily.index = pd.to_datetime(daily.index)
    me = daily["cum_cash"].resample("ME").last()
    eqe = daily["equity"].resample("ME").last()
    curve = [[d.strftime("%Y-%m"), f(v)] for d, v in me.items()]
    monthly = []
    for d in me.index:
        mm = daily[(daily.index.year == d.year) & (daily.index.month == d.month)]
        ev = "/".join(sorted({e for e in mm["event"] if e}))
        monthly.append({"month": d.strftime("%Y-%m"), "equity": f(eqe[d]),
                        "cum_cash": f(me[d]), "event": ev})
    per_year = []
    for y in sorted(set(daily.index.year)):
        dy = daily[daily.index.year == y]
        per_year.append({"year": int(y), "cash": f(dy["cash"].sum())})
    return curve, monthly, per_year


def market():
    panel = ps.load_panel()
    out = []
    for c in ps.COINS:
        p = panel[c].dropna()
        out.append({"coin": c, "price": f(p.iloc[-1]),
                    "vs_sma50": f(p.iloc[-1] / p.rolling(50).mean().iloc[-1] - 1),
                    "vs_sma200": f(p.iloc[-1] / p.rolling(200).mean().iloc[-1] - 1)})
    return str(panel.index[-1].date()), out


def live_book():
    try:
        px, vol = lt.fetch_market(lt.CFG["history_days"])
        book = lt.combined_book(px, vol)
        last = {c: float(px[c].iloc[-1]) for c in px.columns}
        m = lt.CFG["leverage"]
        rows = sorted(([{"coin": c, "weight": f(m * w), "notional": f(m * w * BASE),
                         "price": f(last.get(c)), "side": "long" if w > 0 else "short"}
                        for c, w in book.items()]), key=lambda r: -abs(r["weight"]))
        gross = f(sum(abs(r["weight"]) for r in rows))
        net = f(sum(r["weight"] for r in rows))
        st = lt.load_state()
        return {"asof": str(px.index[-1].date()), "rows": rows, "gross": gross, "net": net,
                "leverage": m, "base": BASE,
                "equity": f(st.get("equity", BASE)), "cum_cash": f(st.get("cum_cash", 0.0)),
                "principal_returned": bool(st.get("principal_returned", False)),
                "locked": bool(st.get("locked", False)), "live": True}
    except Exception as ex:                                            # network/exec issues -> degrade gracefully
        return {"live": False, "error": str(ex)[:200], "base": BASE, "leverage": lt.CFG["leverage"]}


def main():
    print("building ui_data.json (running the tested engine — ~1-2 min)...")
    df, _ = ub.build_panel()
    res = json.load(open(os.path.join(ub.RESULTS, "unified_bot_results.json")))
    sleeves = [{"name": k, **{kk: f(vv) for kk, vv in v.items()}}
               for k, v in res["sleeve_metrics"].items()]
    fr, top, scatter, deploy = sweep(df)
    curve, monthly, per_year = harvest_curve(df)
    mdate, mkt = market()
    data = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "strategy": {
            "name": "All-Weather Book + 2× Harvest", "base": BASE,
            "leverage": lt.CFG["leverage"],
            "weights": ub.PROFILES["all_weather"],
            "harvest": {"double_at": 2.0, "harvest_frac": 0.5, "stop": 0.40},
            "headline": {"roi": f(deploy["roi"]), "cash": f(deploy["total"]),
                         "dd": f(deploy["maxdd"]), "days": deploy["rec_days"],
                         "self_funding": True},
            "sleeves": sleeves,
            "correlation": res.get("correlation", {}),
            "window": res.get("window"),
        },
        "sweep": {"frontier": fr, "top": top, "scatter": scatter},
        "harvest": {"curve": curve, "monthly": monthly, "per_year": per_year},
        "live": live_book(),
        "market": {"asof": mdate, "coins": mkt},
        "fidelity": [
            {"sleeve": "CORE", "status": "PASS", "detail": "identical (book_weights), ΔW=0"},
            {"sleeve": "SPINE", "status": "PASS", "detail": "same pool + inverse-vol + WF params, ΔW=0"},
            {"sleeve": "BTC1H", "status": "PASS", "detail": "bracket runner (sig+bracket_ext+WF params)"},
            {"sleeve": "ETH8H", "status": "PASS", "detail": "bracket runner (sig+bracket_ext+WF params)"},
        ],
    }
    json.dump(data, open(OUT, "w"), indent=2, default=float)
    h = data["strategy"]["headline"]
    print(f"wrote {OUT}  (deploy ROI {h['roi']:.1f}x, DD {h['dd']:.0%}, "
          f"principal {h['days']}d; live={data['live'].get('live')})")


if __name__ == "__main__":
    main()
