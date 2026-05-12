# Dukascopy Data Pipeline

Phase-1 infrastructure for a systematic trading bot focused on liquidity sweep
strategies. Downloads, parses, validates, analyzes, and visualizes 1-minute
OHLCV candles from Dukascopy's free historical feed for a configured set of
FX/commodity instruments and date range.

## What it does

| Stage      | Output                                                          |
| ---------- | --------------------------------------------------------------- |
| download   | `output/cache/{INSTRUMENT}/YYYY-MM-DD.bi5` (raw LZMA1)          |
| parse      | `output/csv/{INSTRUMENT}.csv` (timestamp_utc, OHLCV)            |
| validate   | log lines per instrument; data quality counters in summary.txt  |
| analyze    | daily OHLC, range/return %, ATR(14), top-15 stress days, Asian/London/NY session H/L for EURUSD, cross-pair correlation |
| visualize  | `output/plots/{INSTRUMENT}.png` (3-panel chart with event lines) |
| summarize  | `output/summary.txt`                                             |

## How to run

```bash
pip install -r requirements.txt

# Defaults: 2025-11-01 -> 2026-05-12, 6 instruments, 10 download workers.
python -m dukascopy_pipeline.main

# Override range / instruments:
python -m dukascopy_pipeline.main \
    --start 2025-11-01 --end 2026-05-12 \
    --instruments EURUSD,XAUUSD

# 1-week sanity check, print first 5 candles per instrument:
python -m dukascopy_pipeline.main \
    --start 2026-05-05 --end 2026-05-12 \
    --instruments EURUSD,USDJPY,XAUUSD \
    --print-sample 5

# Re-run analytics on a populated cache (no HTTP):
python -m dukascopy_pipeline.main --skip-download
```

CLI flags:

| Flag               | Default                  | Effect                                        |
| ------------------ | ------------------------ | --------------------------------------------- |
| `--start`          | 2025-11-01               | inclusive start date                          |
| `--end`            | 2026-05-12               | inclusive end date                            |
| `--instruments`    | 6 default pairs          | comma-separated codes                         |
| `--workers`        | 10                       | concurrent HTTP workers                       |
| `--output-dir`     | `dukascopy_pipeline/output` | root for cache/csv/plots/summary.txt        |
| `--skip-download`  | off                      | reuse existing cache without HTTP             |
| `--skip-plot`      | off                      | skip PNG rendering                            |
| `--print-sample N` | 0                        | print first N parsed candles per instrument   |
| `-v`               | off                      | DEBUG-level logging                           |

## Output layout

```
output/
├── cache/
│   ├── EURUSD/2025-11-03.bi5         # raw compressed payload (or 0-byte for 404)
│   └── ...
├── csv/
│   ├── EURUSD.csv                    # timestamp_utc, open, high, low, close, volume
│   └── ...
├── plots/
│   ├── EURUSD.png                    # 3 stacked panels, monthly x-ticks, stress-event lines
│   └── ...
└── summary.txt
```

## Output meaning

- **summary.txt** — per-instrument candle counts, date coverage, gap counts,
  OHLC violations, spike counts, top-5 stress days, daily-return correlation
  matrix, and notable observations (largest single-day move, longest gap).
- **CSV** — one row per minute, UTC timestamps, no scaling applied. If you see
  `1.0852` for EURUSD, that's the actual price.
- **plots/{INSTRUMENT}.png** — top panel: hourly close. Middle: daily range %
  with 95th-percentile reference line. Bottom: daily return %, green
  positive / red negative. Vertical dashed lines mark configured stress
  events with rotated labels.

## Architecture

```
dukascopy_pipeline/
├── config.py        # all constants: URL template, instruments, sessions, events, paths
├── downloader.py    # ThreadPoolExecutor + retry + cache + 404-tolerant
├── parser.py        # LZMA1 decompress + struct unpack -> DataFrame -> CSV
├── validator.py     # gap detection, OHLC sanity, spike detection, zero-volume count
├── analyzer.py      # daily aggregation, ATR, stress days, sessions, correlation
├── visualizer.py    # 3-panel matplotlib renderer with event annotations
├── main.py          # CLI + orchestration + summary writer
├── requirements.txt
├── README.md
└── tests/
    └── test_parser.py   # synthetic .bi5 round-trip
```

Each module has type hints, uses the `logging` module (not `print`), and
catches specific exceptions only.

## Format notes (read this if parsing breaks)

- URL path month is **0-indexed**: January = `00`, December = `11`. Bug in
  this is the most common reason new users see 404 storms.
- File is **raw LZMA1 (FORMAT_ALONE)**, not xz. The parser falls back to
  `FORMAT_AUTO` if the strict format fails on a file.
- Each record is **24 bytes big-endian** in this exact order:
  `uint32 time_offset_seconds, float32 open, float32 close, float32 low,
  float32 high, float32 volume`. Note that the on-disk order is
  open/close/low/high; the parser reorders to standard OHLC for the CSV.
- `time_offset_seconds` is measured from `00:00:00 UTC of the file's day`.
- For most FX pairs the float32 prices are already in correct units. The
  parser checks the first non-empty day of every instrument against
  `EXPECTED_PRICE_RANGE` in `config.py` and **raises `PriceRangeError`** if
  the median is way off — by design, it does NOT auto-scale. Fix the
  scaling explicitly in the parser if you hit this.
- 404 responses for weekends / holidays are expected and handled silently.
  The downloader writes a 0-byte cache marker so subsequent runs skip them.
- If more than 5% of a day's files fail LZMA decompression, the parser
  raises `ParseError` rather than continuing on dirty data.

## Known limitations

- **No FX session-aligned daily bars.** Daily bars are UTC midnight buckets.
  Trading-session-aligned bars (17:00 ET cutoff) are out of scope for Phase 1.
- **Volume is tick volume**, not real volume — Dukascopy is a single
  ECN/STP venue, so volumes are indicative only.
- **Bid-only candles.** Mid/ask are not fetched. Add an `ASK_candles_min_1.bi5`
  variant in `downloader.py` if you need spread analysis.
- **No instrument metadata table.** `EXPECTED_PRICE_RANGE` in `config.py`
  must be extended manually for any new instrument.
- **Single-process.** Each instrument is downloaded sequentially; only the
  per-day fetch within an instrument is parallel. For 6 instruments this
  is fine.

## Phone / mobile use

The pipeline is plain Python with no native dependencies beyond what `pip`
will install for `pandas`/`matplotlib`. It runs on:

- **Android via Termux**: `pkg install python && pip install -r requirements.txt`
- **iOS via a-Shell or iSH**: same `pip install` flow.

Cache size is roughly 100–250 MB for a 6-month, 6-instrument window.

## Sandbox / restricted environments

If you're running inside a sandbox with an outbound network allowlist
(e.g. some CI runners or hosted code-execution environments),
`datafeed.dukascopy.com` may be blocked. There is no proxy workaround
that bypasses a hostname allowlist from inside the sandbox. Run the
pipeline from a host with unrestricted egress, or pre-download the
.bi5 files and drop them under `output/cache/{INSTRUMENT}/YYYY-MM-DD.bi5`
then run with `--skip-download`.

## Tests

```bash
python -m unittest dukascopy_pipeline.tests.test_parser -v
```

The tests round-trip synthetic .bi5 payloads through the parser. They do
not hit the network.

## Non-goals (intentional)

- No sweep detection logic
- No trade simulation or backtest
- No live data streaming
- No ML
- No multi-broker support — Dukascopy only
