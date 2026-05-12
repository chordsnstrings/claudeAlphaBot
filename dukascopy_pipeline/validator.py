"""Data-quality checks on parsed 1-minute candles.

Per-instrument the validator reports:
  - total candles
  - first/last timestamp
  - gaps inside expected FX market hours (Sun 22:00 -> Fri 22:00 UTC)
  - OHLC sanity violations (high < max(o,c,l) or low > min(o,c,h))
  - spikes (range > N * trailing-100-bar median range)
  - zero-volume candle count
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Iterable

import numpy as np
import pandas as pd

from .config import (
    FX_WEEK_CLOSE_DOW,
    FX_WEEK_CLOSE_HOUR,
    FX_WEEK_OPEN_DOW,
    FX_WEEK_OPEN_HOUR,
    SPIKE_LOOKBACK_BARS,
    SPIKE_RANGE_MULTIPLIER,
)

logger = logging.getLogger(__name__)


@dataclass
class GapInfo:
    start: pd.Timestamp
    end: pd.Timestamp
    minutes: int

    def __str__(self) -> str:
        return f"{self.start} -> {self.end} ({self.minutes}m)"


@dataclass
class SpikeInfo:
    timestamp: pd.Timestamp
    range_value: float
    median_range: float
    multiplier: float


@dataclass
class ValidationReport:
    instrument: str
    total_candles: int
    first_timestamp: pd.Timestamp | None
    last_timestamp: pd.Timestamp | None
    gaps: list[GapInfo] = field(default_factory=list)
    ohlc_violations: int = 0
    spikes: list[SpikeInfo] = field(default_factory=list)
    zero_volume_count: int = 0

    @property
    def longest_gap_minutes(self) -> int:
        return max((g.minutes for g in self.gaps), default=0)

    def summary_line(self) -> str:
        first = self.first_timestamp
        last = self.last_timestamp
        return (
            f"{self.instrument}: {self.total_candles:,} candles, "
            f"{first} -> {last}, "
            f"gaps={len(self.gaps)} (longest={self.longest_gap_minutes}m), "
            f"ohlc_violations={self.ohlc_violations}, "
            f"spikes={len(self.spikes)}, zero_vol={self.zero_volume_count}"
        )


# --- Market-hours classification ---------------------------------------------


def _in_fx_market_hours(ts: pd.Timestamp) -> bool:
    """True if ts is within Sun 22:00 -> Fri 22:00 UTC.

    Days are Python weekdays: Mon=0..Sun=6.
    """
    dow = ts.weekday()
    hour = ts.hour
    if dow == FX_WEEK_OPEN_DOW:                                 # Sunday
        return hour >= FX_WEEK_OPEN_HOUR
    if dow == FX_WEEK_CLOSE_DOW:                                # Friday
        return hour < FX_WEEK_CLOSE_HOUR
    if FX_WEEK_CLOSE_DOW < dow < FX_WEEK_OPEN_DOW:              # Saturday
        return False
    return True                                                  # Mon..Thu


# --- Gap detection -----------------------------------------------------------


def detect_gaps(df: pd.DataFrame, max_listed: int = 25) -> list[GapInfo]:
    """Return gaps > 1 minute that fall inside FX market hours.

    A gap is bounded by the prev candle's timestamp and the next candle's
    timestamp; we only count it if any minute *between* them lies inside
    market hours. Truncated to ``max_listed`` longest entries to keep the
    summary readable; the caller can decide whether to log all of them.
    """
    if len(df) < 2:
        return []

    # Strip tz before converting to np.datetime64 to avoid a numpy warning.
    ts_series = df["timestamp_utc"]
    if getattr(ts_series.dt, "tz", None) is not None:
        ts_series = ts_series.dt.tz_convert(None)
    ts = ts_series.to_numpy(dtype="datetime64[ns]")
    diffs_ns = np.diff(ts).astype("int64")
    minute_ns = 60 * 1_000_000_000
    gap_idx = np.where(diffs_ns > minute_ns)[0]

    gaps: list[GapInfo] = []
    for i in gap_idx:
        start = pd.Timestamp(ts[i])
        end = pd.Timestamp(ts[i + 1])
        # Walk forward minute-by-minute checking market hours. Cap the walk
        # to avoid pathological cost on huge gaps (>30 days).
        cursor = start + pd.Timedelta(minutes=1)
        in_hours = False
        steps = 0
        while cursor < end and steps < 60 * 24 * 7:  # 1 week max
            if _in_fx_market_hours(cursor):
                in_hours = True
                break
            cursor += pd.Timedelta(minutes=1)
            steps += 1
        if in_hours:
            minutes = int(diffs_ns[i] // minute_ns) - 1
            gaps.append(GapInfo(start=start, end=end, minutes=minutes))

    gaps.sort(key=lambda g: g.minutes, reverse=True)
    return gaps[:max_listed]


# --- OHLC sanity -------------------------------------------------------------


def count_ohlc_violations(df: pd.DataFrame) -> int:
    if df.empty:
        return 0
    o, h, l, c = df["open"], df["high"], df["low"], df["close"]
    bad = (h < np.maximum.reduce([o, c, l])) | (l > np.minimum.reduce([o, c, h]))
    return int(bad.sum())


# --- Spike detection ---------------------------------------------------------


def detect_spikes(
    df: pd.DataFrame,
    lookback: int = SPIKE_LOOKBACK_BARS,
    multiplier: float = SPIKE_RANGE_MULTIPLIER,
) -> list[SpikeInfo]:
    if len(df) < lookback + 1:
        return []
    rng = (df["high"] - df["low"]).to_numpy()
    # Trailing median (excluding current bar) using rolling.
    trailing_median = pd.Series(rng).shift(1).rolling(lookback, min_periods=lookback).median().to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = np.where(trailing_median > 0, rng / trailing_median, 0.0)
    mask = ratio >= multiplier
    out: list[SpikeInfo] = []
    for idx in np.where(mask)[0]:
        out.append(
            SpikeInfo(
                timestamp=pd.Timestamp(df["timestamp_utc"].iloc[int(idx)]),
                range_value=float(rng[idx]),
                median_range=float(trailing_median[idx]),
                multiplier=float(ratio[idx]),
            )
        )
    return out


# --- Top-level entry ---------------------------------------------------------


def validate(instrument: str, df: pd.DataFrame) -> ValidationReport:
    if df.empty:
        return ValidationReport(
            instrument=instrument,
            total_candles=0,
            first_timestamp=None,
            last_timestamp=None,
        )
    report = ValidationReport(
        instrument=instrument,
        total_candles=len(df),
        first_timestamp=pd.Timestamp(df["timestamp_utc"].iloc[0]),
        last_timestamp=pd.Timestamp(df["timestamp_utc"].iloc[-1]),
        gaps=detect_gaps(df),
        ohlc_violations=count_ohlc_violations(df),
        spikes=detect_spikes(df),
        zero_volume_count=int((df["volume"] == 0).sum()),
    )
    logger.info(report.summary_line())
    return report


def validate_all(parsed: dict[str, pd.DataFrame]) -> dict[str, ValidationReport]:
    return {inst: validate(inst, df) for inst, df in parsed.items()}
