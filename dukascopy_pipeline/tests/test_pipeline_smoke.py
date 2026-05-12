"""End-to-end smoke test: synthesize .bi5 cache files, run main.run() with
--skip-download, and assert each pipeline stage produces sensible output.

This exercises downloader cache layout, parser, validator, analyzer, and
visualizer without requiring network access. Random walk parameters are
chosen so the output looks like real market data (EURUSD ~1.08, XAUUSD
~$2400).
"""

from __future__ import annotations

import math
import os
import random
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

from dukascopy_pipeline.config import PipelineConfig
from dukascopy_pipeline.downloader import cache_path_for, daterange
from dukascopy_pipeline.main import run
from dukascopy_pipeline.parser import encode_bi5_bytes


def _synth_day(seed: int, start_price: float, vol: float = 0.0002) -> bytes:
    """Generate one day of 1-minute bars as compressed .bi5 bytes.

    Returns empty bytes for weekends so the cache layout matches reality.
    """
    rng = random.Random(seed)
    records: list[tuple[int, float, float, float, float, float]] = []
    price = start_price
    for minute in range(0, 1440):
        o = price
        c = o * (1 + rng.gauss(0, vol))
        hi = max(o, c) * (1 + abs(rng.gauss(0, vol / 2)))
        lo = min(o, c) * (1 - abs(rng.gauss(0, vol / 2)))
        v = abs(rng.gauss(80, 20))
        records.append((minute * 60, o, c, lo, hi, v))
        price = c
    return encode_bi5_bytes(records)


def _seed_cache(cache_root: Path, instruments: dict[str, float], start: datetime, end: datetime) -> int:
    """Write synthetic .bi5 files into the cache for every weekday in range.

    Returns total files written.
    """
    written = 0
    for inst, start_price in instruments.items():
        for i, day in enumerate(daterange(start, end)):
            path = cache_path_for(cache_root, inst, day)
            path.parent.mkdir(parents=True, exist_ok=True)
            if day.weekday() >= 5:  # Sat/Sun: simulate 404 -> empty marker
                path.write_bytes(b"")
            else:
                blob = _synth_day(seed=i * 17 + hash(inst) % 1000, start_price=start_price)
                path.write_bytes(blob)
                start_price *= 1 + (i % 7 - 3) * 0.0008  # gentle drift across days
            written += 1
    return written


class PipelineSmokeTest(unittest.TestCase):
    def test_run_pipeline_with_skip_download(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            cfg = PipelineConfig(
                start_date=datetime(2026, 5, 1),
                end_date=datetime(2026, 5, 12),
                instruments=("EURUSD", "XAUUSD"),
                workers=2,
                output_root=output,
                skip_download=True,
                skip_plot=False,
                print_sample=0,
            )
            cfg.ensure_dirs()
            n = _seed_cache(
                cfg.cache_dir,
                {"EURUSD": 1.0850, "XAUUSD": 2410.0},
                cfg.start_date, cfg.end_date,
            )
            self.assertGreater(n, 0)

            rc = run(cfg)
            self.assertEqual(rc, 0)

            # CSVs exist, are non-empty, have the documented columns.
            for inst in cfg.instruments:
                csv = cfg.csv_dir / f"{inst}.csv"
                self.assertTrue(csv.exists(), f"missing {csv}")
                df = pd.read_csv(csv)
                self.assertGreater(len(df), 0, f"{inst} csv is empty")
                self.assertEqual(
                    list(df.columns),
                    ["timestamp_utc", "open", "high", "low", "close", "volume"],
                )

            # Plots rendered.
            for inst in cfg.instruments:
                self.assertTrue((cfg.plot_dir / f"{inst}.png").exists())

            # Summary written and contains the expected sections.
            summary = cfg.summary_path.read_text()
            self.assertIn("Per-instrument", summary)
            self.assertIn("EURUSD", summary)
            self.assertIn("XAUUSD", summary)
            self.assertIn("Daily-return correlation matrix", summary)
            self.assertIn("Notable observations", summary)


if __name__ == "__main__":
    unittest.main()
