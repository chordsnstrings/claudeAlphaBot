"""Analysis on parsed candle data: daily aggregation, stress days, sessions, correlation.

Aggregations are done in UTC. Daily bars are computed by resampling to 1D
buckets aligned at 00:00 UTC; this is the simplest and most reproducible
choice. NY-session-aligned daily bars (17:00 ET cutoff) are out of scope
for Phase 1.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date
from typing import Iterable

import numpy as np
import pandas as pd

from .config import (
    ATR_PERIOD,
    SESSIONS,
    SESSION_INSTRUMENTS,
    TOP_STRESS_DAYS,
    SessionWindow,
)

logger = logging.getLogger(__name__)


# --- Data containers ---------------------------------------------------------


@dataclass
class StressDay:
    day: pd.Timestamp
    open_: float
    high: float
    low: float
    close: float
    range_pct: float
    return_pct: float
    combined_rank: float


@dataclass
class SessionLevels:
    day: pd.Timestamp
    session: str
    high: float
    low: float


@dataclass
class InstrumentAnalysis:
    instrument: str
    daily: pd.DataFrame                  # daily OHLC + range_pct + return_pct + atr
    stress_days: list[StressDay] = field(default_factory=list)
    session_levels: list[SessionLevels] = field(default_factory=list)
    biggest_abs_return_pct: float = 0.0
    biggest_abs_return_day: pd.Timestamp | None = None


# --- Daily aggregation -------------------------------------------------------


def aggregate_daily(df: pd.DataFrame) -> pd.DataFrame:
    """Resample 1-minute bars to daily OHLCV bars (UTC midnight buckets)."""
    if df.empty:
        return pd.DataFrame(
            columns=["open", "high", "low", "close", "volume",
                     "range_pct", "return_pct", "atr"]
        )
    s = df.set_index("timestamp_utc").sort_index()
    daily = s.resample("1D").agg(
        open=("open", "first"),
        high=("high", "max"),
        low=("low", "min"),
        close=("close", "last"),
        volume=("volume", "sum"),
    ).dropna(subset=["open", "close"])

    daily["range_pct"] = (daily["high"] - daily["low"]) / daily["close"] * 100.0
    daily["return_pct"] = daily["close"].pct_change() * 100.0
    daily["atr"] = _atr(daily, ATR_PERIOD)
    return daily


def _atr(daily: pd.DataFrame, period: int) -> pd.Series:
    """Standard ATR on daily bars: mean of true range over `period` days."""
    high = daily["high"]
    low = daily["low"]
    prev_close = daily["close"].shift(1)
    tr = pd.concat(
        [(high - low),
         (high - prev_close).abs(),
         (low - prev_close).abs()],
        axis=1,
    ).max(axis=1)
    return tr.rolling(period, min_periods=period).mean()


# --- Stress-day ranking ------------------------------------------------------


def rank_stress_days(daily: pd.DataFrame, top_n: int = TOP_STRESS_DAYS) -> list[StressDay]:
    """Top N days by combined rank of |return_pct| and range_pct.

    Combined rank = average of percentile ranks (0..1). Higher is more stressful.
    """
    if daily.empty:
        return []
    work = daily.dropna(subset=["return_pct", "range_pct"]).copy()
    if work.empty:
        return []
    work["abs_ret"] = work["return_pct"].abs()
    work["rank_ret"] = work["abs_ret"].rank(pct=True)
    work["rank_rng"] = work["range_pct"].rank(pct=True)
    work["combined"] = (work["rank_ret"] + work["rank_rng"]) / 2.0
    top = work.sort_values("combined", ascending=False).head(top_n)
    return [
        StressDay(
            day=pd.Timestamp(idx),
            open_=float(row["open"]),
            high=float(row["high"]),
            low=float(row["low"]),
            close=float(row["close"]),
            range_pct=float(row["range_pct"]),
            return_pct=float(row["return_pct"]),
            combined_rank=float(row["combined"]),
        )
        for idx, row in top.iterrows()
    ]


# --- Session H/L (EURUSD) ----------------------------------------------------


def _session_mask(ts: pd.Series, session: SessionWindow) -> pd.Series:
    """Boolean mask for timestamps inside [session.start, session.end) UTC."""
    t = ts.dt.time
    if session.start_utc <= session.end_utc:
        return (t >= session.start_utc) & (t < session.end_utc)
    # Wrap-around session (not used by defaults but supported).
    return (t >= session.start_utc) | (t < session.end_utc)


def compute_session_levels(df: pd.DataFrame) -> list[SessionLevels]:
    """For each UTC day, compute H/L per session window."""
    if df.empty:
        return []
    work = df.copy()
    work["date"] = work["timestamp_utc"].dt.date
    out: list[SessionLevels] = []
    for session in SESSIONS:
        mask = _session_mask(work["timestamp_utc"], session)
        sub = work.loc[mask]
        if sub.empty:
            continue
        grouped = sub.groupby("date").agg(high=("high", "max"), low=("low", "min"))
        for d, row in grouped.iterrows():
            out.append(
                SessionLevels(
                    day=pd.Timestamp(d),
                    session=session.name,
                    high=float(row["high"]),
                    low=float(row["low"]),
                )
            )
    out.sort(key=lambda s: (s.day, s.session))
    return out


# --- Cross-pair correlation --------------------------------------------------


def correlation_matrix(
    daily_by_instrument: dict[str, pd.DataFrame],
) -> pd.DataFrame:
    """Daily-return correlation across instruments (Pearson, pairwise)."""
    series: dict[str, pd.Series] = {}
    for inst, daily in daily_by_instrument.items():
        if daily.empty or "return_pct" not in daily.columns:
            continue
        s = daily["return_pct"].dropna()
        if not s.empty:
            series[inst] = s
    if not series:
        return pd.DataFrame()
    combined = pd.concat(series, axis=1, join="outer")
    combined.columns = list(series.keys())
    return combined.corr(method="pearson", min_periods=5)


# --- Top-level entry ---------------------------------------------------------


def analyze_instrument(instrument: str, df: pd.DataFrame) -> InstrumentAnalysis:
    daily = aggregate_daily(df)
    stress = rank_stress_days(daily)
    sessions = (
        compute_session_levels(df)
        if instrument in SESSION_INSTRUMENTS
        else []
    )
    biggest_day: pd.Timestamp | None = None
    biggest_abs = 0.0
    if not daily.empty and daily["return_pct"].notna().any():
        idx = daily["return_pct"].abs().idxmax()
        biggest_day = pd.Timestamp(idx)
        biggest_abs = float(daily.loc[idx, "return_pct"])
    logger.info(
        "%s: %d daily bars, %d stress days flagged, %d session-level rows",
        instrument, len(daily), len(stress), len(sessions),
    )
    return InstrumentAnalysis(
        instrument=instrument,
        daily=daily,
        stress_days=stress,
        session_levels=sessions,
        biggest_abs_return_pct=biggest_abs,
        biggest_abs_return_day=biggest_day,
    )


def analyze_all(parsed: dict[str, pd.DataFrame]) -> dict[str, InstrumentAnalysis]:
    return {inst: analyze_instrument(inst, df) for inst, df in parsed.items()}
