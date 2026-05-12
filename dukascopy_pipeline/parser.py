"""LZMA decompression and binary -> DataFrame parsing for Dukascopy candles.

Each .bi5 file holds one UTC day of records, each 24 bytes big-endian:
  uint32  time_offset_seconds (since 00:00 UTC of that day)
  float32 open
  float32 close
  float32 low
  float32 high
  float32 volume

The compressed stream is raw LZMA1 (FORMAT_ALONE), not xz. Parsing is
strict — if a day's median price is wildly outside the instrument's
expected range we raise PriceRangeError so the operator can investigate
the point-value treatment rather than silently auto-scaling.
"""

from __future__ import annotations

import logging
import lzma
import struct
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

import pandas as pd

from .config import (
    BAR_RECORD_SIZE,
    BAR_STRUCT_FORMAT,
    EXPECTED_PRICE_RANGE,
)
from .downloader import DownloadResult, cache_path_for, daterange

logger = logging.getLogger(__name__)


CSV_COLUMNS: tuple[str, ...] = ("timestamp_utc", "open", "high", "low", "close", "volume")


class ParseError(Exception):
    """Raised when a .bi5 file is structurally malformed."""


class PriceRangeError(Exception):
    """Raised when parsed prices look implausible for the instrument.

    Per the spec we STOP and report rather than auto-scale; the operator
    must confirm the point-value treatment and adjust the parser.
    """


@dataclass(frozen=True)
class ParseStats:
    instrument: str
    files_seen: int
    files_with_data: int
    files_empty: int
    decompression_failures: int
    total_records: int


# --- Single-file parsing ------------------------------------------------------


def _decompress(blob: bytes) -> bytes:
    """LZMA1 (FORMAT_ALONE) decompression. Empty input -> empty output."""
    if not blob:
        return b""
    try:
        return lzma.decompress(blob, format=lzma.FORMAT_ALONE)
    except lzma.LZMAError as exc:
        # Some Dukascopy nodes occasionally send xz-framed payloads; try AUTO
        # as a fallback before declaring failure.
        try:
            return lzma.decompress(blob, format=lzma.FORMAT_AUTO)
        except lzma.LZMAError:
            raise ParseError(f"LZMA decompression failed: {exc}") from exc


def parse_bi5_bytes(blob: bytes, day: datetime) -> pd.DataFrame:
    """Parse one day's decompressed-or-compressed payload into a DataFrame.

    Accepts the raw .bi5 bytes (compressed). Returns a DataFrame with
    columns CSV_COLUMNS, indexed 0..N-1, sorted by timestamp ascending.
    """
    raw = _decompress(blob)
    if not raw:
        return pd.DataFrame(columns=CSV_COLUMNS)

    if len(raw) % BAR_RECORD_SIZE != 0:
        raise ParseError(
            f"decompressed payload {len(raw)}B is not a multiple of "
            f"{BAR_RECORD_SIZE}B record size"
        )

    n = len(raw) // BAR_RECORD_SIZE
    unpack = struct.Struct(BAR_STRUCT_FORMAT).unpack_from

    offsets = [0] * n
    opens = [0.0] * n
    closes = [0.0] * n
    lows = [0.0] * n
    highs = [0.0] * n
    vols = [0.0] * n

    for i in range(n):
        # Per spec: time, open, close, low, high, volume.
        t, o, c, lo, hi, v = unpack(raw, i * BAR_RECORD_SIZE)
        offsets[i] = t
        opens[i] = o
        closes[i] = c
        lows[i] = lo
        highs[i] = hi
        vols[i] = v

    day_start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    timestamps = [day_start + timedelta(seconds=t) for t in offsets]

    df = pd.DataFrame(
        {
            "timestamp_utc": pd.to_datetime(timestamps, utc=True),
            "open": opens,
            "high": highs,
            "low": lows,
            "close": closes,
            "volume": vols,
        }
    )
    return df


def parse_bi5_file(path: Path, day: datetime) -> pd.DataFrame:
    if not path.exists():
        return pd.DataFrame(columns=CSV_COLUMNS)
    return parse_bi5_bytes(path.read_bytes(), day)


# --- Plausibility check -------------------------------------------------------


def _check_price_range(instrument: str, df: pd.DataFrame) -> None:
    """Raise PriceRangeError if median close is far outside expected range.

    We check the median (not min/max) so a single bad print doesn't
    trigger; and we use a 5x slack on each side so daily volatility
    doesn't trigger either.
    """
    if df.empty or instrument not in EXPECTED_PRICE_RANGE:
        return
    lo, hi = EXPECTED_PRICE_RANGE[instrument]
    median = float(df["close"].median())
    if median <= 0 or median < lo / 5 or median > hi * 5:
        raise PriceRangeError(
            f"{instrument}: median close {median:.6g} is far outside "
            f"expected range [{lo}, {hi}]. STOP — verify point-value "
            "treatment in parser before continuing. Do NOT auto-scale."
        )


# --- Per-instrument batch -----------------------------------------------------


def parse_instrument(
    instrument: str,
    start: datetime,
    end: datetime,
    cache_root: Path,
    csv_dir: Path,
) -> tuple[pd.DataFrame, ParseStats]:
    """Decompress + parse every cached day for one instrument; write one CSV.

    Returns the concatenated DataFrame and a ParseStats record. Days with
    no cached file (download error) are silently skipped — the validator
    will catch the resulting gap.
    """
    csv_dir.mkdir(parents=True, exist_ok=True)
    frames: list[pd.DataFrame] = []
    files_seen = 0
    files_empty = 0
    decompression_failures = 0
    first_nonempty_checked = False

    for day in daterange(start, end):
        path = cache_path_for(cache_root, instrument, day)
        if not path.exists():
            continue
        files_seen += 1
        size = path.stat().st_size
        if size == 0:
            files_empty += 1
            continue
        try:
            df = parse_bi5_bytes(path.read_bytes(), day)
        except ParseError as exc:
            decompression_failures += 1
            logger.warning("parse failure %s %s: %s", instrument, day.date(), exc)
            continue

        if not df.empty:
            if not first_nonempty_checked:
                _check_price_range(instrument, df)
                first_nonempty_checked = True
            frames.append(df)

    if frames:
        combined = pd.concat(frames, ignore_index=True)
        combined = combined.sort_values("timestamp_utc").drop_duplicates(
            subset=["timestamp_utc"], keep="last"
        ).reset_index(drop=True)
    else:
        combined = pd.DataFrame(columns=CSV_COLUMNS)

    csv_path = csv_dir / f"{instrument}.csv"
    combined.to_csv(csv_path, index=False)
    logger.info(
        "%s: parsed %d records from %d files (%d empty) -> %s",
        instrument, len(combined), files_seen, files_empty, csv_path,
    )

    # Quarantine guard: if >5% of non-empty files failed to decompress,
    # the spec says STOP and report.
    nonempty = files_seen - files_empty
    if nonempty > 0 and decompression_failures / nonempty > 0.05:
        raise ParseError(
            f"{instrument}: {decompression_failures}/{nonempty} files failed "
            "LZMA decompression (>5%). STOP and investigate."
        )

    return combined, ParseStats(
        instrument=instrument,
        files_seen=files_seen,
        files_with_data=nonempty - decompression_failures,
        files_empty=files_empty,
        decompression_failures=decompression_failures,
        total_records=len(combined),
    )


def parse_all(
    instruments: Iterable[str],
    start: datetime,
    end: datetime,
    cache_root: Path,
    csv_dir: Path,
) -> dict[str, tuple[pd.DataFrame, ParseStats]]:
    out: dict[str, tuple[pd.DataFrame, ParseStats]] = {}
    for instrument in instruments:
        out[instrument] = parse_instrument(
            instrument, start, end, cache_root, csv_dir
        )
    return out


# --- Synthetic encoder for tests ---------------------------------------------


def encode_bi5_bytes(records: list[tuple[int, float, float, float, float, float]]) -> bytes:
    """Encode (offset, open, close, low, high, volume) tuples to compressed .bi5.

    Used by tests/test_parser.py to round-trip data without a network fetch.
    Order matches Dukascopy's on-disk layout (note: open, close, low, high).
    """
    pack = struct.Struct(BAR_STRUCT_FORMAT).pack
    raw = b"".join(pack(t, o, c, lo, hi, v) for (t, o, c, lo, hi, v) in records)
    return lzma.compress(raw, format=lzma.FORMAT_ALONE)
