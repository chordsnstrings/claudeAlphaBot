/**
 * News-event registry used by the FrictionModel to widen spreads / slippage
 * around major scheduled releases.
 *
 * Events are loaded from packages/adapters/data/news_events.json. The
 * window is ±15 minutes (spec §6.4).
 *
 * The shipped dataset is documented in the JSON file; users with their
 * own authoritative calendar can point the FrictionModel at a different
 * file via the constructor.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "@trading/core";

const log = logger("adapters.friction.news");

export type NewsCategory = "FOMC" | "NFP" | "US_CPI" | "ECB" | "BoE";

export interface NewsEvent {
  /** ISO-8601 in UTC. */
  timestamp: string;
  category: NewsCategory;
  /** Short description for audit logs. */
  description?: string;
}

export interface LoadedNewsEvent {
  timestampMs: number;
  category: NewsCategory;
  description?: string;
}

/** Default location of the bundled dataset. */
export function defaultNewsEventsPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/friction/news.js -> data/news_events.json
  return resolve(here, "..", "..", "data", "news_events.json");
}

export async function loadNewsEvents(
  path: string = defaultNewsEventsPath(),
): Promise<LoadedNewsEvent[]> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as { events: NewsEvent[] };
  if (!Array.isArray(parsed.events)) {
    throw new Error(`news_events.json at ${path} missing "events" array`);
  }
  const out: LoadedNewsEvent[] = parsed.events.map((e) => {
    const ms = Date.parse(e.timestamp);
    if (!Number.isFinite(ms)) {
      throw new Error(`unparseable timestamp in news_events.json: ${e.timestamp}`);
    }
    const loaded: LoadedNewsEvent = { timestampMs: ms, category: e.category };
    if (e.description !== undefined) {
      loaded.description = e.description;
    }
    return loaded;
  });
  out.sort((a, b) => a.timestampMs - b.timestampMs);
  log.info({ path, count: out.length }, "loaded news events");
  return out;
}

/** Spec §6.4 — ±15 minutes around any major event. */
export const NEWS_WINDOW_MS = 15 * 60 * 1000;

/**
 * Binary-search the sorted event list for any event within +/- the window.
 * O(log n) per lookup; intended to be called per-bar.
 */
export function isInNewsWindow(
  events: readonly LoadedNewsEvent[],
  atMs: number,
  windowMs: number = NEWS_WINDOW_MS,
): boolean {
  if (events.length === 0) {
    return false;
  }
  // Find the first event with timestampMs >= atMs - window.
  const lowerBound = atMs - windowMs;
  const upperBound = atMs + windowMs;
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const ev = events[mid];
    if (ev === undefined || ev.timestampMs < lowerBound) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const candidate = events[lo];
  return candidate !== undefined && candidate.timestampMs <= upperBound;
}
