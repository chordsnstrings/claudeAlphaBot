"""Configuration constants for the Dukascopy pipeline.

All paths, defaults, instrument lists, session windows, and stress event
annotations live here. Override at the CLI via main.py flags rather than
editing this file.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, time
from pathlib import Path
from typing import Mapping

# --- URL & binary format -----------------------------------------------------

# Dukascopy serves files under YEAR/MONTH/DAY where MONTH IS 0-INDEXED.
# January = 0, December = 11. This is the most common bug; be careful.
DUKASCOPY_URL_TEMPLATE: str = (
    "https://datafeed.dukascopy.com/datafeed/"
    "{instrument}/{year:04d}/{month:02d}/{day:02d}/BID_candles_min_1.bi5"
)

# 24-byte big-endian record:
#   uint32  time_offset_seconds (since 00:00:00 UTC of the day)
#   float32 open
#   float32 close
#   float32 low
#   float32 high
#   float32 volume
BAR_RECORD_SIZE: int = 24
BAR_STRUCT_FORMAT: str = ">Ifffff"

# --- Date range & instruments ------------------------------------------------

START_DATE: datetime = datetime(2025, 11, 1)
END_DATE: datetime = datetime(2026, 5, 12)

INSTRUMENTS: tuple[str, ...] = (
    "EURUSD",
    "USDJPY",
    "USDCHF",
    "GBPUSD",
    "XAUUSD",
    "BRENTCMDUSD",
)

# Plausibility ranges for spot-checking parsed prices. If the median
# of an instrument's first day falls outside its range, the parser
# raises rather than auto-scaling.
EXPECTED_PRICE_RANGE: Mapping[str, tuple[float, float]] = {
    "EURUSD":      (0.80, 1.80),
    "GBPUSD":      (1.00, 2.00),
    "USDJPY":      (70.0, 200.0),
    "USDCHF":      (0.50, 1.50),
    "AUDUSD":      (0.50, 1.20),
    "NZDUSD":      (0.40, 1.10),
    "USDCAD":      (0.90, 1.80),
    "XAUUSD":      (1500.0, 6000.0),
    "XAGUSD":      (10.0, 80.0),
    "BRENTCMDUSD": (20.0, 200.0),
    "WTICOUSD":    (10.0, 200.0),
}

# --- Concurrency, retries, paths --------------------------------------------

DOWNLOAD_WORKERS: int = 10
MAX_RETRIES: int = 3
RETRY_BACKOFF_BASE_SECONDS: float = 1.5
HTTP_TIMEOUT_SECONDS: float = 30.0

# Some Dukascopy edge nodes 403 plain Python User-Agents. Use a browser UA.
HTTP_HEADERS: Mapping[str, str] = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    ),
    "Accept": "*/*",
}

REPO_ROOT: Path = Path(__file__).resolve().parent
OUTPUT_ROOT: Path = REPO_ROOT / "output"
CACHE_DIR: Path = OUTPUT_ROOT / "cache"
CSV_DIR: Path = OUTPUT_ROOT / "csv"
PLOT_DIR: Path = OUTPUT_ROOT / "plots"
SUMMARY_PATH: Path = OUTPUT_ROOT / "summary.txt"

# --- Session windows (UTC) ---------------------------------------------------
# Used by analyzer to compute per-session H/L for EURUSD. Times are inclusive
# of the start, exclusive of the end. These are conventional FX session
# windows; DST is ignored intentionally (we work in UTC throughout).

@dataclass(frozen=True)
class SessionWindow:
    name: str
    start_utc: time
    end_utc: time


SESSIONS: tuple[SessionWindow, ...] = (
    SessionWindow("asian",  time(0, 0),  time(8, 0)),
    SessionWindow("london", time(8, 0),  time(16, 0)),
    SessionWindow("ny",     time(13, 0), time(21, 0)),
)

# Instruments for which we compute per-session H/L. Spec calls out EURUSD only.
SESSION_INSTRUMENTS: tuple[str, ...] = ("EURUSD",)

# --- Stress event annotations ------------------------------------------------
# Plotted as vertical lines on every instrument chart with a label.

@dataclass(frozen=True)
class StressEvent:
    date: datetime
    label: str


STRESS_EVENTS: tuple[StressEvent, ...] = (
    StressEvent(datetime(2026, 2, 28), "US-Israel strike on Iran (Operation Epic Fury)"),
    StressEvent(datetime(2026, 3, 9),  "Brent crosses $100"),
    StressEvent(datetime(2026, 4, 8),  "US-Iran ceasefire"),
    StressEvent(datetime(2026, 4, 17), "Hormuz briefly reopens"),
    StressEvent(datetime(2026, 4, 20), "US Navy seizes Iranian ship"),
)

# --- Validation thresholds ---------------------------------------------------

SPIKE_RANGE_MULTIPLIER: float = 10.0
SPIKE_LOOKBACK_BARS: int = 100
ATR_PERIOD: int = 14
TOP_STRESS_DAYS: int = 15
TOP_STRESS_DAYS_IN_SUMMARY: int = 5

# FX market hours: closes Fri 22:00 UTC, opens Sun 22:00 UTC. A "gap" is
# any missing minute inside that window.
FX_WEEK_OPEN_DOW: int = 6   # Sunday (Python: Mon=0..Sun=6)
FX_WEEK_OPEN_HOUR: int = 22
FX_WEEK_CLOSE_DOW: int = 4  # Friday
FX_WEEK_CLOSE_HOUR: int = 22


@dataclass(frozen=True)
class PipelineConfig:
    """Resolved per-run configuration; built by main.py from CLI + defaults."""

    start_date: datetime
    end_date: datetime
    instruments: tuple[str, ...]
    workers: int = DOWNLOAD_WORKERS
    output_root: Path = OUTPUT_ROOT
    skip_download: bool = False
    skip_plot: bool = False
    print_sample: int = 0  # if >0, print first N candles per instrument

    @property
    def cache_dir(self) -> Path:
        return self.output_root / "cache"

    @property
    def csv_dir(self) -> Path:
        return self.output_root / "csv"

    @property
    def plot_dir(self) -> Path:
        return self.output_root / "plots"

    @property
    def summary_path(self) -> Path:
        return self.output_root / "summary.txt"

    def ensure_dirs(self) -> None:
        for d in (self.cache_dir, self.csv_dir, self.plot_dir):
            d.mkdir(parents=True, exist_ok=True)
