"""Round-trip parser tests using synthetic .bi5 payloads.

Run with: python -m unittest dukascopy_pipeline.tests.test_parser
"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone

from dukascopy_pipeline.parser import (
    ParseError,
    PriceRangeError,
    encode_bi5_bytes,
    parse_bi5_bytes,
)


class ParserRoundTripTests(unittest.TestCase):
    def test_roundtrip_eurusd_three_bars(self) -> None:
        # Three 1-min bars at 00:00, 00:01, 00:02 UTC.
        records = [
            (0,   1.0850, 1.0852, 1.0849, 1.0853, 100.0),
            (60,  1.0852, 1.0855, 1.0851, 1.0856, 120.0),
            (120, 1.0855, 1.0853, 1.0852, 1.0857, 90.0),
        ]
        blob = encode_bi5_bytes(records)
        df = parse_bi5_bytes(blob, datetime(2025, 11, 3))

        self.assertEqual(len(df), 3)
        self.assertEqual(
            list(df.columns),
            ["timestamp_utc", "open", "high", "low", "close", "volume"],
        )
        self.assertEqual(
            df["timestamp_utc"].iloc[0],
            datetime(2025, 11, 3, 0, 0, tzinfo=timezone.utc),
        )
        self.assertAlmostEqual(df["open"].iloc[0], 1.0850, places=4)
        self.assertAlmostEqual(df["high"].iloc[1], 1.0856, places=4)
        self.assertAlmostEqual(df["low"].iloc[2],  1.0852, places=4)
        self.assertAlmostEqual(df["close"].iloc[2], 1.0853, places=4)
        self.assertEqual(df["volume"].iloc[1], 120.0)

    def test_empty_payload_returns_empty_frame(self) -> None:
        df = parse_bi5_bytes(b"", datetime(2025, 11, 3))
        self.assertTrue(df.empty)
        self.assertEqual(
            list(df.columns),
            ["timestamp_utc", "open", "high", "low", "close", "volume"],
        )

    def test_corrupt_lzma_raises_parse_error(self) -> None:
        with self.assertRaises(ParseError):
            parse_bi5_bytes(b"not lzma data", datetime(2025, 11, 3))

    def test_truncated_records_raise_parse_error(self) -> None:
        # Build a valid LZMA stream of 25 bytes (not a multiple of 24).
        import lzma
        bad = lzma.compress(b"\x00" * 25, format=lzma.FORMAT_ALONE)
        with self.assertRaises(ParseError):
            parse_bi5_bytes(bad, datetime(2025, 11, 3))


class PriceRangeChecks(unittest.TestCase):
    def test_check_price_range_passes_for_eurusd(self) -> None:
        from dukascopy_pipeline.parser import _check_price_range
        import pandas as pd
        df = pd.DataFrame({"close": [1.085, 1.086, 1.087]})
        # Should not raise.
        _check_price_range("EURUSD", df)

    def test_check_price_range_raises_when_offset(self) -> None:
        from dukascopy_pipeline.parser import _check_price_range
        import pandas as pd
        # 1,180,000 instead of 1.18 — the canonical "scaled by point value" bug.
        df = pd.DataFrame({"close": [1_180_000.0, 1_180_500.0]})
        with self.assertRaises(PriceRangeError):
            _check_price_range("EURUSD", df)


if __name__ == "__main__":
    unittest.main()
