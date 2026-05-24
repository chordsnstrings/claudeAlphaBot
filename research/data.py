"""Data layer for the crypto strategy research harness.

Source: Coin Metrics community network data (public, on GitHub).
We only need a clean daily close series per asset. We use
``ReferenceRateUSD`` (Coin Metrics' robust reference price) and fall
back to ``PriceUSD`` when the reference rate is missing.

Exchange APIs (Binance/Kraken/Coinbase/CoinGecko) are blocked in this
environment, but ``raw.githubusercontent.com`` is reachable, so we pull
the Coin Metrics CSVs from there once and cache a slim ``date,close``
series locally for fully offline, reproducible backtests.
"""
from __future__ import annotations

import io
import os
import sys
import urllib.request

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")

CM_BASE = "https://raw.githubusercontent.com/coinmetrics/data/master/csv"

# Asset -> (coinmetrics file, first date we consider "liquid / tradeable").
#
# NOTE on SOL: Coin Metrics' *community* CSVs only carry a full price history
# for assets old enough to have the legacy ``PriceUSD`` field. Newer 2020+
# listings (SOL, AVAX, MATIC) expose only a 7-row ``ReferenceRateUSD`` stub in
# the community tier, and every crypto exchange / aggregator API is blocked by
# this sandbox's egress allowlist. SOL spot price therefore cannot be sourced
# offline here. DOT is included as the closest *available* high-beta L1 analog
# (also a 2020 launch) so the "high-vol alt behaves differently" thesis can
# still be validated. The SOL slot is kept ready for when real data is present
# (e.g. running against the bot's Binance loader outside the sandbox).
ASSETS = {
    "BTC": ("btc.csv", "2014-01-01"),   # major / store-of-value
    "ETH": ("eth.csv", "2016-06-01"),   # major / smart-contract L1
    "DOT": ("dot.csv", "2020-08-20"),   # high-beta L1 (SOL analog)
    "LINK": ("link.csv", "2017-10-01"), # high-beta alt
    "ADA": ("ada.csv", "2017-12-01"),   # high-beta L1
    "DOGE": ("doge.csv", "2015-01-01"), # meme / fat-tailed
    "XRP": ("xrp.csv", "2014-08-15"),   # payments / episodic
    "LTC": ("ltc.csv", "2013-04-01"),   # old major
    "BNB": ("bnb.csv", "2017-07-15"),   # exchange token
}

# Assets the goal names explicitly. SOL is unavailable offline (see note above);
# DOT is its stand-in for the high-beta-L1 regime.
CORE_ASSETS = ["BTC", "ETH", "DOT"]


def _slim_path(asset: str) -> str:
    return os.path.join(DATA_DIR, f"{asset}_daily.csv")


def fetch_and_cache(asset: str, force: bool = False) -> pd.DataFrame:
    """Download the Coin Metrics CSV, extract a clean daily close series,
    cache it as ``data/<ASSET>_daily.csv`` and return it."""
    os.makedirs(DATA_DIR, exist_ok=True)
    slim = _slim_path(asset)
    if os.path.exists(slim) and not force:
        return load_cached(asset)

    fname, start = ASSETS[asset]
    url = f"{CM_BASE}/{fname}"
    print(f"[data] downloading {asset} from {url}", file=sys.stderr)
    req = urllib.request.Request(url, headers={"User-Agent": "research/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 (trusted host)
        raw = resp.read().decode("utf-8")

    df = pd.read_csv(io.StringIO(raw), usecols=lambda c: c in (
        "time", "ReferenceRateUSD", "PriceUSD", "volume_reported_spot_usd_1d",
    ), low_memory=False)
    df = df.rename(columns={"time": "date"})
    df["date"] = pd.to_datetime(df["date"]).dt.tz_localize(None)
    # Prefer whichever price column has real coverage. For older assets that is
    # the legacy PriceUSD; for a few it is ReferenceRateUSD. Fill gaps from the
    # other to be safe.
    have = [c for c in ("PriceUSD", "ReferenceRateUSD") if c in df.columns]
    if not have:
        raise RuntimeError(f"{asset}: no price column in source CSV")
    primary = max(have, key=lambda c: df[c].notna().sum())
    close = df[primary].copy()
    for c in have:
        if c != primary:
            close = close.fillna(df[c])
    df["close"] = close
    vol = df["volume_reported_spot_usd_1d"] if "volume_reported_spot_usd_1d" in df.columns else pd.NA
    out = pd.DataFrame({"date": df["date"], "close": df["close"], "volume_usd": vol})
    out = out.dropna(subset=["close"])
    out = out[out["close"] > 0]
    out = out[out["date"] >= pd.Timestamp(start)]
    out = out.sort_values("date").reset_index(drop=True)
    out.to_csv(slim, index=False)
    print(f"[data] {asset}: {len(out)} rows {out['date'].iloc[0].date()} -> {out['date'].iloc[-1].date()}",
          file=sys.stderr)
    return out


def load_cached(asset: str) -> pd.DataFrame:
    slim = _slim_path(asset)
    df = pd.read_csv(slim, parse_dates=["date"])
    return df.sort_values("date").reset_index(drop=True)


def load(asset: str, force: bool = False) -> pd.DataFrame:
    if os.path.exists(_slim_path(asset)) and not force:
        return load_cached(asset)
    return fetch_and_cache(asset, force=force)


if __name__ == "__main__":
    force = "--force" in sys.argv
    for a in ASSETS:
        d = fetch_and_cache(a, force=force)
        print(f"{a}: {len(d)} rows, {d['date'].iloc[0].date()} -> {d['date'].iloc[-1].date()}, "
              f"last close={d['close'].iloc[-1]:.2f}")
