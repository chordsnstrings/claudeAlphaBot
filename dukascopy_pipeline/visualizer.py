"""Matplotlib renderer: 3-panel PNG per instrument with stress-event markers.

Top panel:    hourly close line chart (largest)
Middle panel: daily range % bar chart with 95th-percentile horizontal line
Bottom panel: daily return % bar chart, green positive / red negative
All three share the x-axis. Vertical lines mark configured stress events.
"""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from typing import Iterable

import matplotlib

matplotlib.use("Agg")  # headless; safe for servers, phones, CI
import matplotlib.dates as mdates  # noqa: E402
import matplotlib.pyplot as plt    # noqa: E402
import numpy as np                  # noqa: E402
import pandas as pd                 # noqa: E402

from .analyzer import InstrumentAnalysis  # noqa: E402
from .config import STRESS_EVENTS, StressEvent  # noqa: E402

logger = logging.getLogger(__name__)


def _hourly_close(df: pd.DataFrame) -> pd.Series:
    if df.empty:
        return pd.Series(dtype="float64")
    s = df.set_index("timestamp_utc")["close"].sort_index()
    return s.resample("1h").last().dropna()


def _draw_event_lines(
    ax: plt.Axes,
    events: Iterable[StressEvent],
    label_top: bool,
    xmin: pd.Timestamp,
    xmax: pd.Timestamp,
) -> None:
    # Normalize comparison: strip tz for both sides since stress events are
    # date-only (no specific time, and no timezone in config).
    xmin_naive = xmin.tz_localize(None) if xmin.tzinfo is not None else xmin
    xmax_naive = xmax.tz_localize(None) if xmax.tzinfo is not None else xmax
    for ev in events:
        ts = pd.Timestamp(ev.date)
        if not (xmin_naive <= ts <= xmax_naive):
            continue
        ax.axvline(ev.date, color="black", linestyle="--", linewidth=0.8, alpha=0.6)
        if label_top:
            ax.annotate(
                ev.label,
                xy=(ev.date, ax.get_ylim()[1]),
                xytext=(2, -10),
                textcoords="offset points",
                rotation=90,
                fontsize=7,
                ha="left",
                va="top",
                color="black",
                alpha=0.8,
            )


def render_instrument(
    analysis: InstrumentAnalysis,
    minute_df: pd.DataFrame,
    out_path: Path,
    events: Iterable[StressEvent] = STRESS_EVENTS,
) -> Path | None:
    if minute_df.empty or analysis.daily.empty:
        logger.warning("no data to plot for %s; skipping", analysis.instrument)
        return None

    hourly = _hourly_close(minute_df)
    daily = analysis.daily

    xmin = pd.Timestamp(min(hourly.index.min(), daily.index.min()))
    xmax = pd.Timestamp(max(hourly.index.max(), daily.index.max()))

    fig, (ax_price, ax_range, ax_ret) = plt.subplots(
        nrows=3,
        ncols=1,
        sharex=True,
        figsize=(14, 10),
        gridspec_kw={"height_ratios": [3, 1, 1]},
    )

    # --- Top: hourly close ---
    ax_price.plot(hourly.index, hourly.values, color="#1f4e79", linewidth=0.9)
    ax_price.set_ylabel("Price (hourly close)")
    ax_price.grid(True, linestyle=":", alpha=0.4)
    _draw_event_lines(ax_price, events, label_top=True, xmin=xmin, xmax=xmax)

    # --- Middle: daily range % ---
    ax_range.bar(daily.index, daily["range_pct"], width=0.8, color="#4a7ab8", alpha=0.85)
    if daily["range_pct"].notna().any():
        p95 = float(np.nanpercentile(daily["range_pct"].to_numpy(), 95))
        ax_range.axhline(
            p95, color="red", linestyle="--", linewidth=0.9,
            label=f"95th pct = {p95:.2f}%",
        )
        ax_range.legend(loc="upper right", fontsize=8)
    ax_range.set_ylabel("Daily range %")
    ax_range.grid(True, linestyle=":", alpha=0.4)
    _draw_event_lines(ax_range, events, label_top=False, xmin=xmin, xmax=xmax)

    # --- Bottom: daily return % ---
    ret = daily["return_pct"].fillna(0.0)
    colors = np.where(ret.values >= 0, "#2e8b57", "#c0392b")
    ax_ret.bar(daily.index, ret.values, width=0.8, color=colors, alpha=0.9)
    ax_ret.axhline(0.0, color="black", linewidth=0.6)
    ax_ret.set_ylabel("Daily return %")
    ax_ret.grid(True, linestyle=":", alpha=0.4)
    _draw_event_lines(ax_ret, events, label_top=False, xmin=xmin, xmax=xmax)

    # --- X-axis formatting ---
    ax_ret.xaxis.set_major_locator(mdates.MonthLocator())
    ax_ret.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))
    ax_ret.xaxis.set_minor_locator(mdates.WeekdayLocator(byweekday=mdates.MO))
    for label in ax_ret.get_xticklabels():
        label.set_rotation(0)

    title = (
        f"{analysis.instrument}  |  "
        f"{xmin:%Y-%m-%d}  ->  {xmax:%Y-%m-%d}  |  "
        f"{len(daily)} daily bars, {len(minute_df):,} 1-min bars"
    )
    fig.suptitle(title, fontsize=12, y=0.995)
    fig.tight_layout(rect=(0, 0, 1, 0.985))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_path, dpi=120)
    plt.close(fig)
    logger.info("wrote %s", out_path)
    return out_path


def render_all(
    analyses: dict[str, InstrumentAnalysis],
    minute_data: dict[str, pd.DataFrame],
    plot_dir: Path,
) -> dict[str, Path | None]:
    out: dict[str, Path | None] = {}
    for inst, analysis in analyses.items():
        out[inst] = render_instrument(
            analysis,
            minute_data.get(inst, pd.DataFrame()),
            plot_dir / f"{inst}.png",
        )
    return out
