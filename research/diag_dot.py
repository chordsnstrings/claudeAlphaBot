"""Diagnostic: understand DOT's regime structure and where strategies lose."""
import numpy as np, pandas as pd
import data as datamod
from engine import backtest, Costs, compute_metrics, ema, realized_vol
from strategies import all_families, Family, sig_tsmom_blend, sig_donchian, sig_trend_flat, build_weights
from walkforward import walk_forward

df = datamod.load("DOT")
p = pd.Series(df["close"].values, index=pd.DatetimeIndex(df["date"])).sort_index()
print("DOT price path (quarterly):")
print(p.resample("QE").last().round(2).to_string())

ret = p.pct_change()
print(f"\nann vol (full): {ret.std()*np.sqrt(365):.2f}")
# yearly returns
print("\nyearly B&H return:")
print((p.resample("YE").last().pct_change()).round(3).to_string())

# Donchian winner folds
fam = next(f for f in all_families() if f.name=="donchian")
r = walk_forward("DOT", p, fam, train_days=420, test_days=150, costs=Costs())
print(f"\n=== donchian WF folds (oos cagr {r.oos.cagr:+.1%}, sharpe {r.oos.sharpe:.2f}) ===")
for f in r.folds:
    print(f"  test {f.test_start}..{f.test_end}  ret {f.test_return:+.1%}  dd {f.test_max_dd:+.1%}  "
          f"params entry={f.params.get('entry')},exit={f.params.get('exit')},vt={f.params.get('vol_target')},lo={f.params.get('long_only')}")
