"""Parallel Dukascopy .bi5 downloader with caching, retries, and 404 tolerance.

The downloader's only job is to land raw compressed bytes on disk under
``cache/{instrument}/YYYY-MM-DD.bi5``. Empty files mark known-empty days
(weekends, holidays, server 404s) so the next run can skip them.
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Iterable

import requests

from .config import (
    DUKASCOPY_URL_TEMPLATE,
    HTTP_HEADERS,
    HTTP_TIMEOUT_SECONDS,
    MAX_RETRIES,
    RETRY_BACKOFF_BASE_SECONDS,
)

logger = logging.getLogger(__name__)


# --- Per-day download result --------------------------------------------------


@dataclass(frozen=True)
class DownloadResult:
    instrument: str
    day: datetime
    cache_path: Path
    status: str  # "downloaded" | "cached" | "empty" | "missing" | "error"
    bytes_written: int = 0
    error: str | None = None


# --- URL & path helpers -------------------------------------------------------


def build_url(instrument: str, day: datetime) -> str:
    """Return the Dukascopy URL for an instrument/day.

    Month is 0-indexed in the URL path; this is the format Dukascopy ships,
    not a bug. January = 00, December = 11.
    """
    return DUKASCOPY_URL_TEMPLATE.format(
        instrument=instrument,
        year=day.year,
        month=day.month - 1,  # 0-indexed
        day=day.day,
    )


def cache_path_for(cache_root: Path, instrument: str, day: datetime) -> Path:
    return cache_root / instrument / f"{day:%Y-%m-%d}.bi5"


def daterange(start: datetime, end: datetime) -> Iterable[datetime]:
    """Yield each calendar day from start to end inclusive (UTC midnight)."""
    cur = datetime(start.year, start.month, start.day)
    last = datetime(end.year, end.month, end.day)
    while cur <= last:
        yield cur
        cur += timedelta(days=1)


# --- Single-day fetch ---------------------------------------------------------


def _fetch_one(
    session: requests.Session,
    instrument: str,
    day: datetime,
    cache_root: Path,
) -> DownloadResult:
    """Fetch one day's .bi5 with cache + retry + 404 tolerance."""
    dest = cache_path_for(cache_root, instrument, day)
    if dest.exists():
        return DownloadResult(instrument, day, dest, "cached", dest.stat().st_size)

    dest.parent.mkdir(parents=True, exist_ok=True)
    url = build_url(instrument, day)

    last_err: str | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = session.get(url, headers=HTTP_HEADERS, timeout=HTTP_TIMEOUT_SECONDS)
        except requests.RequestException as exc:
            last_err = f"{type(exc).__name__}: {exc}"
            logger.debug("attempt %d/%d %s %s: %s",
                         attempt, MAX_RETRIES, instrument, day.date(), last_err)
        else:
            if resp.status_code == 200:
                # Empty body still happens for thin liquidity days; record empty.
                dest.write_bytes(resp.content)
                if not resp.content:
                    return DownloadResult(instrument, day, dest, "empty", 0)
                return DownloadResult(
                    instrument, day, dest, "downloaded", len(resp.content)
                )
            if resp.status_code == 404:
                # Weekends / holidays / closed days. Mark with empty cache file.
                dest.write_bytes(b"")
                return DownloadResult(instrument, day, dest, "missing", 0)
            last_err = f"HTTP {resp.status_code}"
            logger.debug("attempt %d/%d %s %s: %s",
                         attempt, MAX_RETRIES, instrument, day.date(), last_err)

        if attempt < MAX_RETRIES:
            sleep_s = RETRY_BACKOFF_BASE_SECONDS * (2 ** (attempt - 1))
            time.sleep(sleep_s)

    logger.warning("giving up on %s %s after %d retries: %s",
                   instrument, day.date(), MAX_RETRIES, last_err)
    return DownloadResult(instrument, day, dest, "error", 0, error=last_err)


# --- Batch driver -------------------------------------------------------------


def download_instrument(
    instrument: str,
    start: datetime,
    end: datetime,
    cache_root: Path,
    workers: int,
) -> list[DownloadResult]:
    """Download every day in [start, end] for one instrument, in parallel."""
    days = list(daterange(start, end))
    logger.info("downloading %s: %d days, %d workers", instrument, len(days), workers)

    results: list[DownloadResult] = []
    counts = {"downloaded": 0, "cached": 0, "empty": 0, "missing": 0, "error": 0}

    # One requests.Session per worker thread via thread-local would be ideal;
    # a single shared Session is safe because requests.Session is thread-safe
    # for simple GETs against the same host with connection pooling.
    session = requests.Session()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(_fetch_one, session, instrument, day, cache_root): day
            for day in days
        }
        for i, future in enumerate(as_completed(futures), start=1):
            r = future.result()
            results.append(r)
            counts[r.status] = counts.get(r.status, 0) + 1
            if i % 25 == 0 or i == len(days):
                logger.info(
                    "  %s: %d/%d (downloaded=%d cached=%d missing=%d error=%d)",
                    instrument, i, len(days),
                    counts["downloaded"], counts["cached"],
                    counts["missing"], counts["error"],
                )

    if counts["error"]:
        logger.warning("%s: %d days errored after retries", instrument, counts["error"])
    return results


def download_all(
    instruments: Iterable[str],
    start: datetime,
    end: datetime,
    cache_root: Path,
    workers: int,
) -> dict[str, list[DownloadResult]]:
    """Download all instruments sequentially; each instrument fans out internally."""
    cache_root.mkdir(parents=True, exist_ok=True)
    out: dict[str, list[DownloadResult]] = {}
    for instrument in instruments:
        out[instrument] = download_instrument(
            instrument, start, end, cache_root, workers
        )
    return out
