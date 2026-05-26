"""DCA averaging-down grid, 20x leverage, +20% take-profit, ETH hour-by-hour.

Faithful event simulation of the proposed strategy:
  * 20x leverage long on ETH, 1h bars.
  * each cycle: deploy 5% of equity as margin (=1x notional at 20x); avg entry = price.
  * DCA: every -5% price move, add another 5%-margin tranche, lowering the average.
  * TAKE PROFIT: close the whole position at +20% profit ON MARGIN (= +1% price move
    from the average entry, since 20 * 1% = 20%).
  * LIQUIDATION (the part that kills it): at 20x you are wiped when price is ~5% below
    the average entry (loss = margin). Note the trap: the first DCA trigger (-5%) is the
    SAME distance as liquidation -- so a 5% drop both 'wants to add' and liquidates.
  * fees: 0.05%/side taker on notional (huge at 20x: ~1% of margin per side).

Reports: cycles, per-cycle win rate, liquidations, final equity, ruin, per-year.
"""
from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
FEE = 0.0005          # taker per side on notional
LEV = 20.0
MARGIN_FRAC = 0.05    # 5% of equity per tranche
DCA_STEP = 0.05       # add every -5%
TP_ON_MARGIN = 0.20   # close at +20% on margin  -> +1% price at 20x
MAX_ADDS = 8


def load_1h():
    df = pd.read_csv(os.path.join(HERE, "data", "intraday", "ETH_1h.csv"))
    idx = pd.to_datetime(df["timestamp_ms"], unit="ms", utc=True).dt.tz_localize(None)
    df.index = idx
    return df[["open", "high", "low", "close"]].astype(float).sort_index()


def simulate(ohlc, lev=LEV, margin_frac=MARGIN_FRAC, dca_step=DCA_STEP,
             tp_margin=TP_ON_MARGIN, max_adds=MAX_ADDS, start_equity=1.0,
             tp_price=None):
    hi = ohlc["high"].values; lo = ohlc["low"].values; cl = ohlc["close"].values
    t_idx = ohlc.index
    E = start_equity
    in_pos = False
    avg = notional = deployed = last_add = 0.0
    n_adds = 0
    cycle_start_E = 0.0
    wins = losses = liqs = 0
    eq_curve = np.empty(len(cl)); eq_curve[:] = np.nan
    ruin_at = None
    # TP as an explicit price move (tp_price) OR as %-on-margin (tp_margin/lev)
    tp_price_mult = (1.0 + tp_price) if tp_price is not None else (1.0 + tp_margin / lev)
    liq_mult = 1.0 - 1.0 / lev
    for i in range(len(cl)):
        if in_pos:
            # LIQUIDATION is unconditional: if the bar's LOW breaches avg*liq_mult, you
            # are closed at -100% of margin, regardless of where the bar closes.
            if lo[i] <= avg * liq_mult:
                E -= deployed
                losses += 1; liqs += 1
                in_pos = False
            # take profit if the bar's HIGH reaches the TP (only if not liquidated)
            elif hi[i] >= avg * tp_price_mult:
                pnl = notional * (tp_price_mult - 1.0)   # filled at TP price
                E += pnl - FEE * notional
                wins += 1
                in_pos = False
            # DCA add if the bar's LOW hit the next grid step (and survived liq)
            elif lo[i] <= last_add * (1.0 - dca_step) and n_adds < max_adds:
                add_margin = margin_frac * cycle_start_E
                add_notional = lev * add_margin
                fill = last_add * (1.0 - dca_step)
                avg = (avg * notional + fill * add_notional) / (notional + add_notional)
                notional += add_notional
                deployed += add_margin
                E -= FEE * add_notional
                last_add = fill
                n_adds += 1
        if not in_pos and E > 0.05:
            cycle_start_E = E
            deployed = margin_frac * E
            notional = lev * deployed
            avg = cl[i]; last_add = cl[i]; n_adds = 1
            E -= FEE * notional
            in_pos = True
        eq_curve[i] = E + (notional * (cl[i] / avg - 1.0) if in_pos else 0.0)
        if eq_curve[i] <= 0.05 and ruin_at is None:
            ruin_at = t_idx[i]
            break
    valid = eq_curve[~np.isnan(eq_curve)]
    return dict(final_equity=float(max(valid[-1], 0.0)) if len(valid) else 0.0,
                wins=wins, losses=losses, liquidations=liqs,
                cycles=wins + losses,
                win_rate=wins / max(wins + losses, 1),
                ruin_at=str(ruin_at.date()) if ruin_at is not None else None,
                eq=pd.Series(eq_curve, index=t_idx))


def main(argv):
    price = load_1h()
    print(f"ETH 1h {price.index[0].date()}->{price.index[-1].date()}  "
          f"DCA grid, {int(LEV)}x, +{int(TP_ON_MARGIN*100)}% TP on margin (+"
          f"{TP_ON_MARGIN/LEV:.1%} price), DCA every -{int(DCA_STEP*100)}%\n")

    print("Break-even math first:")
    print(f"  win  = +{TP_ON_MARGIN:.0%} on a {MARGIN_FRAC:.0%} tranche = +{TP_ON_MARGIN*MARGIN_FRAC:.1%} of equity")
    print(f"  loss = liquidation = -100% of deployed margin (>= {MARGIN_FRAC:.0%}, more after DCA)")
    print(f"  => need win rate > {1/(1+TP_ON_MARGIN):.0%} JUST to break even on a single tranche, "
          f"before fees and before DCA enlarges the losses.\n")

    res = simulate(price)
    print(f"FULL RUN (2020-2026):")
    print(f"  cycles={res['cycles']}  win_rate={res['win_rate']:.1%}  "
          f"liquidations={res['liquidations']}  final_equity={res['final_equity']:.3f}x  "
          f"ruin={'YES @ '+res['ruin_at'] if res['ruin_at'] else 'no'}")
    eq = res["eq"].dropna()
    for y in sorted(set(eq.index.year)):
        ey = eq[eq.index.year == y]
        if len(ey) > 10:
            print(f"    {y}: equity {ey.iloc[0]:.3f} -> {ey.iloc[-1]:.3f}")

    # sensitivity: lower leverage / wider TP
    print("\nSensitivity (final equity, ruin):")
    print(f"  {'lev':>4} {'tp_margin':>9} {'winRate':>8} {'liq':>5} {'final':>8} {'ruin':>12}")
    for lev in (20, 10, 5):
        for tpm in (0.20, 0.50):
            r = simulate(price, lev=lev, tp_margin=tpm)
            print(f"  {lev:>3}x {tpm:>9.0%} {r['win_rate']:>8.1%} {r['liquidations']:>5} "
                  f"{r['final_equity']:>7.3f}x {(r['ruin_at'] or 'no'):>12}")
    print("\nVERDICT below.")


if __name__ == "__main__":
    main(sys.argv[1:])
