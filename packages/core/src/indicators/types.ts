/**
 * Shared types for the indicator library.
 *
 * Bars use string-coded prices to preserve precision when sourced from the
 * DB (Drizzle returns numeric() columns as strings). For indicator math we
 * convert to JS numbers; the loss is at most ~15 significant digits which
 * comfortably covers our 18,6 numeric range.
 */

export interface OhlcvBar {
  /** ISO-millisecond timestamp; not used in indicator math directly. */
  readonly timestampUtc?: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume?: number;
}

export interface OhlcvStringBar {
  readonly timestampUtc?: Date;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume?: string;
}

/**
 * Convert a numeric-string OHLCV bar (as returned by the DB) into the
 * numeric form the indicator library operates on.
 */
export function toNumericBar(b: OhlcvStringBar): OhlcvBar {
  const out: OhlcvBar = {
    open: Number(b.open),
    high: Number(b.high),
    low: Number(b.low),
    close: Number(b.close),
  };
  return b.timestampUtc !== undefined
    ? { ...out, timestampUtc: b.timestampUtc }
    : out;
}

/**
 * Streaming indicator interface. Each call to `update` consumes one input
 * (a number for value-based indicators, a Bar for bar-based ones) and
 * returns the latest computed value, or null while still in the warm-up
 * window.
 */
export interface StreamingIndicator<TInput, TOutput> {
  update(input: TInput): TOutput | null;
  readonly value: TOutput | null;
  readonly samplesSeen: number;
}
