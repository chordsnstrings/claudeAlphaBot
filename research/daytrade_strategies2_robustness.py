"""Throwaway diagnostic: is the ETH-8H cluster broad or a fat-tail/lucky-fold mirage?
For each cell: per-fold nets (to see fold concentration) and top-trade share of the
total log-return (to see trade concentration)."""
import numpy as np
from daytrade_strategies2 import walk_forward

CELLS = [
    ("BTC", "1h", "regime_pullback"),   # the consistent benchmark
    ("BTC", "8h", "breakout"),
    ("ETH", "8h", "regime_pullback"),
    ("ETH", "8h", "eth_btc_gated"),
    ("ETH", "8h", "eth_btc_rs"),
    ("ETH", "8h", "tod_pullback"),
    ("ETH", "4h", "regime_pullback"),
]
for sym, tf, name in CELLS:
    r = walk_forward(sym, tf, name)
    if r.get("status") != "ok":
        print(f"{sym} {tf} {name}: {r.get('status')}"); continue
    rets = np.array(r["oos_returns"])
    logs = np.log1p(rets)
    tot_log = logs.sum()
    order = np.argsort(logs)[::-1]
    top1 = logs[order[0]] / tot_log if tot_log != 0 else float("nan")
    top3 = logs[order[:3]].sum() / tot_log if tot_log != 0 else float("nan")
    top5 = logs[order[:5]].sum() / tot_log if tot_log != 0 else float("nan")
    fn = np.array(r["fold_nets"])
    # multiplicative contribution of the single best fold to the total wealth multiple
    wealth = np.prod(1 + fn)
    best_fold = fn.max()
    # net if we DROP the single best fold
    drop_best = np.prod(1 + np.delete(fn, fn.argmax())) - 1
    print(f"\n{sym} {tf} {name}: net={r['oos_net']:+.1%} PF={r['oos_profit_factor']:.2f} "
          f"win={r['oos_win_rate']:.1%} n={r['oos_n_trades']} folds_pos={int((fn>0).sum())}/{len(fn)}")
    print(f"   per-fold nets: {[f'{x:+.0%}' for x in fn]}")
    print(f"   best fold={best_fold:+.0%}  net w/o best fold={drop_best:+.1%}  "
          f"max single-trade={rets.max():+.1%} min={rets.min():+.1%}")
    print(f"   top-1/3/5 trade share of total log-return: "
          f"{top1:.0%} / {top3:.0%} / {top5:.0%}")
    from collections import Counter
    ekeys = Counter(str(sorted(ep.items())) for ep, xp in r["picks"])
    xkeys = Counter(str(sorted(xp.items())) for ep, xp in r["picks"])
    print(f"   most-selected entry: {ekeys.most_common(1)[0]}")
    print(f"   most-selected exit : {xkeys.most_common(1)[0]}")
