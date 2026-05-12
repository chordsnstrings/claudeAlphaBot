"""End-to-end Dukascopy pipeline entry point.

Usage:
    python -m dukascopy_pipeline.main \
        --start 2025-11-01 --end 2026-05-12 \
        --instruments EURUSD,USDJPY,USDCHF,GBPUSD,XAUUSD,BRENTCMDUSD

Or with defaults from config.py:
    python main.py

Stages:
    1. download .bi5 files (cached, parallel, retry, 404-tolerant)
    2. parse + decompress -> per-instrument CSV
    3. validate (gaps, OHLC sanity, spikes, zero-volume)
    4. analyze (daily aggregation, ATR, stress days, sessions, correlations)
    5. visualize (3-panel PNG per instrument)
    6. write summary.txt
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime
from pathlib import Path
from typing import Sequence

import pandas as pd

from .analyzer import (
    InstrumentAnalysis,
    analyze_all,
    correlation_matrix,
)
from .config import (
    END_DATE,
    INSTRUMENTS,
    OUTPUT_ROOT,
    PipelineConfig,
    START_DATE,
    STRESS_EVENTS,
    TOP_STRESS_DAYS_IN_SUMMARY,
    DOWNLOAD_WORKERS,
)
from .downloader import download_all
from .parser import ParseStats, parse_all
from .validator import ValidationReport, validate_all
from .visualizer import render_all

logger = logging.getLogger("dukascopy_pipeline")


# --- CLI ---------------------------------------------------------------------


def parse_args(argv: Sequence[str] | None = None) -> PipelineConfig:
    p = argparse.ArgumentParser(
        prog="dukascopy_pipeline",
        description="Download, parse, validate, analyze and visualize "
                    "Dukascopy 1-min FX/commodity candles.",
    )
    p.add_argument("--start", type=_parse_date, default=START_DATE,
                   help="inclusive start date YYYY-MM-DD (default %(default)s)")
    p.add_argument("--end", type=_parse_date, default=END_DATE,
                   help="inclusive end date YYYY-MM-DD (default %(default)s)")
    p.add_argument("--instruments", type=str, default=",".join(INSTRUMENTS),
                   help="comma-separated instrument codes (default %(default)s)")
    p.add_argument("--workers", type=int, default=DOWNLOAD_WORKERS,
                   help="concurrent download workers (default %(default)d)")
    p.add_argument("--output-dir", type=Path, default=OUTPUT_ROOT,
                   help="root output directory (default %(default)s)")
    p.add_argument("--skip-download", action="store_true",
                   help="reuse the existing cache without HTTP")
    p.add_argument("--skip-plot", action="store_true",
                   help="skip PNG generation")
    p.add_argument("--print-sample", type=int, default=0, metavar="N",
                   help="print first N parsed candles per instrument (sanity check)")
    p.add_argument("-v", "--verbose", action="store_true",
                   help="DEBUG-level logging")

    args = p.parse_args(argv)
    instruments = tuple(s.strip().upper() for s in args.instruments.split(",") if s.strip())
    if not instruments:
        p.error("--instruments produced an empty list")
    if args.start > args.end:
        p.error(f"--start {args.start.date()} is after --end {args.end.date()}")

    _configure_logging(args.verbose)

    cfg = PipelineConfig(
        start_date=args.start,
        end_date=args.end,
        instruments=instruments,
        workers=args.workers,
        output_root=args.output_dir,
        skip_download=args.skip_download,
        skip_plot=args.skip_plot,
        print_sample=args.print_sample,
    )
    cfg.ensure_dirs()
    return cfg


def _parse_date(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d")


def _configure_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    # Quiet down requests/urllib3 unless verbose.
    if not verbose:
        logging.getLogger("urllib3").setLevel(logging.WARNING)


# --- Sample printer ----------------------------------------------------------


def _print_sample(parsed: dict[str, pd.DataFrame], n: int) -> None:
    if n <= 0:
        return
    sys.stdout.write("\n=== First %d candles per instrument (sanity check) ===\n" % n)
    for inst, df in parsed.items():
        sys.stdout.write(f"\n--- {inst} ---\n")
        if df.empty:
            sys.stdout.write("(no data)\n")
            continue
        # Show as a fixed-width table; round prices to 5 decimals for readability.
        display = df.head(n).copy()
        for col in ("open", "high", "low", "close"):
            display[col] = display[col].round(5)
        display["volume"] = display["volume"].round(2)
        sys.stdout.write(display.to_string(index=False))
        sys.stdout.write("\n")
    sys.stdout.write("\n")
    sys.stdout.flush()


# --- Summary writer ----------------------------------------------------------


def write_summary(
    summary_path: Path,
    cfg: PipelineConfig,
    parse_stats: dict[str, ParseStats],
    reports: dict[str, ValidationReport],
    analyses: dict[str, InstrumentAnalysis],
    corr: pd.DataFrame,
) -> None:
    lines: list[str] = []
    lines.append("Dukascopy pipeline summary")
    lines.append("=" * 78)
    lines.append(f"Range:       {cfg.start_date:%Y-%m-%d} -> {cfg.end_date:%Y-%m-%d}")
    lines.append(f"Instruments: {', '.join(cfg.instruments)}")
    lines.append(f"Generated:   {datetime.utcnow():%Y-%m-%d %H:%M:%S}Z")
    lines.append("")

    # Per-instrument
    lines.append("Per-instrument")
    lines.append("-" * 78)
    for inst in cfg.instruments:
        stats = parse_stats.get(inst)
        report = reports.get(inst)
        analysis = analyses.get(inst)
        if stats is None or report is None or analysis is None:
            lines.append(f"{inst}: (no data)")
            continue
        lines.append(f"{inst}:")
        lines.append(f"  candles_total      : {report.total_candles:,}")
        lines.append(f"  files_with_data    : {stats.files_with_data}")
        lines.append(f"  files_empty        : {stats.files_empty}")
        lines.append(f"  decompress_failures: {stats.decompression_failures}")
        if report.first_timestamp is not None:
            lines.append(f"  first_timestamp    : {report.first_timestamp}")
            lines.append(f"  last_timestamp     : {report.last_timestamp}")
        lines.append(f"  market_hour_gaps   : {len(report.gaps)} "
                     f"(longest {report.longest_gap_minutes}m)")
        lines.append(f"  ohlc_violations    : {report.ohlc_violations}")
        lines.append(f"  spikes_flagged     : {len(report.spikes)}")
        lines.append(f"  zero_volume_bars   : {report.zero_volume_count}")
        if analysis.biggest_abs_return_day is not None:
            lines.append(
                f"  biggest_daily_move : "
                f"{analysis.biggest_abs_return_pct:+.2f}%  on  "
                f"{analysis.biggest_abs_return_day:%Y-%m-%d}"
            )
        # Top 5 stress days
        top = analysis.stress_days[:TOP_STRESS_DAYS_IN_SUMMARY]
        if top:
            lines.append(f"  top_{TOP_STRESS_DAYS_IN_SUMMARY}_stress_days:")
            for d in top:
                lines.append(
                    f"    {d.day:%Y-%m-%d}  "
                    f"return={d.return_pct:+7.2f}%  "
                    f"range={d.range_pct:6.2f}%  "
                    f"rank={d.combined_rank:.3f}"
                )
        lines.append("")

    # Cross-pair correlation
    lines.append("Daily-return correlation matrix (Pearson)")
    lines.append("-" * 78)
    if corr.empty:
        lines.append("(insufficient data)")
    else:
        lines.append(corr.round(3).to_string())
    lines.append("")

    # Notable observations
    lines.append("Notable observations")
    lines.append("-" * 78)
    biggest = max(
        ((inst, a.biggest_abs_return_day, a.biggest_abs_return_pct)
         for inst, a in analyses.items()
         if a.biggest_abs_return_day is not None),
        key=lambda t: abs(t[2]),
        default=None,
    )
    if biggest is not None:
        inst, day, ret = biggest
        lines.append(
            f"Largest single-day move across all instruments: "
            f"{inst} {ret:+.2f}% on {day:%Y-%m-%d}"
        )
    longest_gap = max(
        ((inst, r.longest_gap_minutes) for inst, r in reports.items()),
        key=lambda t: t[1],
        default=None,
    )
    if longest_gap is not None and longest_gap[1] > 0:
        lines.append(
            f"Longest in-market-hours gap: "
            f"{longest_gap[1]}m on {longest_gap[0]}"
        )
    if STRESS_EVENTS:
        lines.append("Annotated stress events:")
        for ev in STRESS_EVENTS:
            lines.append(f"  {ev.date:%Y-%m-%d}  {ev.label}")

    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text("\n".join(lines) + "\n")
    logger.info("wrote %s", summary_path)


# --- Orchestration -----------------------------------------------------------


def run(cfg: PipelineConfig) -> int:
    logger.info("=== stage 1/5: download ===")
    if cfg.skip_download:
        logger.info("--skip-download set; using existing cache at %s", cfg.cache_dir)
    else:
        download_all(
            cfg.instruments, cfg.start_date, cfg.end_date,
            cfg.cache_dir, cfg.workers,
        )

    logger.info("=== stage 2/5: parse ===")
    parsed_with_stats = parse_all(
        cfg.instruments, cfg.start_date, cfg.end_date,
        cfg.cache_dir, cfg.csv_dir,
    )
    parsed: dict[str, pd.DataFrame] = {k: v[0] for k, v in parsed_with_stats.items()}
    parse_stats: dict[str, ParseStats] = {k: v[1] for k, v in parsed_with_stats.items()}

    if cfg.print_sample:
        _print_sample(parsed, cfg.print_sample)

    logger.info("=== stage 3/5: validate ===")
    reports = validate_all(parsed)

    logger.info("=== stage 4/5: analyze ===")
    analyses = analyze_all(parsed)
    daily_by_instrument = {inst: a.daily for inst, a in analyses.items()}
    corr = correlation_matrix(daily_by_instrument)
    if not corr.empty:
        logger.info("correlation matrix:\n%s", corr.round(3).to_string())

    logger.info("=== stage 5/5: visualize ===")
    if cfg.skip_plot:
        logger.info("--skip-plot set; skipping PNG generation")
    else:
        render_all(analyses, parsed, cfg.plot_dir)

    write_summary(cfg.summary_path, cfg, parse_stats, reports, analyses, corr)
    logger.info("done. outputs in %s", cfg.output_root)
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    cfg = parse_args(argv)
    return run(cfg)


if __name__ == "__main__":
    raise SystemExit(main())
