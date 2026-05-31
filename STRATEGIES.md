# Strategies — Versioned Index

This file tracks deployable strategy versions so they don't get overwritten as new work happens.
Each entry is pinned to a specific git commit/tag. To restore any version: `git checkout <tag>`.

---

## v1-combined-blend — LOCKED 2026-05-30

**Git tag:** `v1-combined-blend`
**Branch at lock time:** `claude/eager-ramanujan-MJ4MR`

### What it is
A 50/50 combined ETH+BTC blend, the highest risk-adjusted strategy of the session. Each
asset runs the same architecture: a regime-engine sleeve (long-biased, hedges bears) plus
a breakout-pool sleeve (concurrent 4h Donchian books, trend+ADX filtered, 2:1 brackets
resolved on 1h), weighted 25/75 (regime/pool), vol-targeted to 30% annual vol with a 1.5×
leverage cap. Profits harvested to cash on 15% decay from equity peak + year-end.

### Files (all locked at this version)
- `research/eth_blend.py` — ETH side (regime + pool, 25/75)
- `research/btc_blend.py` — BTC side (same architecture, BTC data)
- `research/combined_blend.py` — 50/50 ETH+BTC + harvest sweep
- `research/eth_engine.py` — parameter-light regime committee (asset-agnostic)
- `research/eth_bracket.py` — bracket simulator + pool_exposure (asset-agnostic)
- `research/scalp_sweep.py` — shared backtest/metrics infrastructure
- `research/bb_harvest_eth.py` — BB dual-leg harvester (tested, rejected as sleeve)
- `research/intraday_live.py`, `research/live_trader.py` — live execution shells

### Performance (WF-OOS, 2020-2026, net 5bps)
| metric | combined | ETH blend | BTC blend |
|---|---|---|---|
| ann return | +34% | +36% | +30% |
| Sharpe | **1.16** | 1.07 | 0.95 |
| Calmar | 1.45 | 1.23 | 1.14 |
| max DD | **−24%** | −28% | −27% |
| WF-OOS (weight WF) | n/a | +24%/0.80 | +14%/0.56 |

### Honest forward expectation
- Combined: **+19%/yr, Sharpe ~0.7, −24% DD** at the deployed 1× config
- Time to 10×: 13y at 1×, 9y at 1.5×, 7y at 2×
- Harvest policy (best): compound until ≥2× base, then harvest excess (locks $3k+ while
  preserving 99% of compound wealth)

### How to restore this exact version
```bash
git fetch --tags
git checkout v1-combined-blend           # detached HEAD at the locked commit
# or to create a recovery branch from it:
git checkout -b restore-v1 v1-combined-blend
```

### Suggested workflow for new strategy work
**Option A — work on the same branch, don't modify v1 files:**
Create new files for the new strategy (e.g., `research/v2_xxx.py`); leave the v1 modules
above untouched. The tag is your safety net if anything goes wrong.

**Option B — branch off for v2 work:**
```bash
git checkout -b strategy/v2-xxx          # new branch for v2
# now any changes here don't affect the v1-combined-blend tag
```

---

<!-- Add new locked versions below as the work evolves -->
