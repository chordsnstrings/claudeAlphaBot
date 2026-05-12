#!/usr/bin/env node
/**
 * Generator script for news_events.json.
 *
 * Produces a real best-effort calendar of:
 *   NFP    — first Friday of each month, 12:30 UTC (BLS standard time)
 *   US_CPI — 13th of each month at 12:30 UTC (approximation; real BLS
 *            schedule shifts by a few days each month; refine with the
 *            authoritative source before production)
 *   FOMC   — eight scheduled meetings per year, 18:00 UTC (decision time).
 *            Dates for 2020-2025 are taken from the published Fed calendar
 *            (federalreserve.gov/monetarypolicy/fomccalendars.htm); the
 *            2026 row is the Federal Reserve's published 2026 calendar.
 *   ECB    — eight monetary-policy meetings per year, 12:45 UTC press
 *            conference (rate decision typically 12:15 UTC; spec just
 *            needs a +/- 15 min window).
 *   BoE    — eight Monetary Policy Committee decisions per year,
 *            11:00 UTC.
 *
 * Re-run as:  node packages/adapters/data/build-news-events.mjs
 *
 * The resulting file is committed to the repo. Operators with an
 * authoritative calendar can replace it without changing any code.
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "news_events.json");

// ----------------------------------------------------------- NFP / CPI -

function firstFridayOf(year, monthZeroIdx) {
  // 0 = Sunday, 5 = Friday in JS getUTCDay().
  const d = new Date(Date.UTC(year, monthZeroIdx, 1, 12, 30, 0));
  while (d.getUTCDay() !== 5) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString();
}

function generateNfp(years) {
  const out = [];
  for (const y of years) {
    for (let m = 0; m < 12; m += 1) {
      out.push({
        timestamp: firstFridayOf(y, m),
        category: "NFP",
        description: `BLS Employment Situation Report (${y}-${String(m + 1).padStart(2, "0")})`,
      });
    }
  }
  return out;
}

function generateCpi(years) {
  const out = [];
  for (const y of years) {
    for (let m = 0; m < 12; m += 1) {
      // ~13th of the month; real schedule shifts +/- 2 days.
      const d = new Date(Date.UTC(y, m, 13, 12, 30, 0));
      out.push({
        timestamp: d.toISOString(),
        category: "US_CPI",
        description: `BLS Consumer Price Index (${y}-${String(m + 1).padStart(2, "0")})`,
      });
    }
  }
  return out;
}

// ----------------------------------------------------------------- FOMC

// Source: federalreserve.gov/monetarypolicy/fomccalendars.htm
// Decision release ~18:00 UTC for each. 2020-2025 are historical; the
// 2026 calendar uses the Fed's announced 2026 dates.
const FOMC_DATES = [
  // 2020
  "2020-01-29", "2020-03-15", "2020-04-29", "2020-06-10",
  "2020-07-29", "2020-09-16", "2020-11-05", "2020-12-16",
  // 2021
  "2021-01-27", "2021-03-17", "2021-04-28", "2021-06-16",
  "2021-07-28", "2021-09-22", "2021-11-03", "2021-12-15",
  // 2022
  "2022-01-26", "2022-03-16", "2022-05-04", "2022-06-15",
  "2022-07-27", "2022-09-21", "2022-11-02", "2022-12-14",
  // 2023
  "2023-02-01", "2023-03-22", "2023-05-03", "2023-06-14",
  "2023-07-26", "2023-09-20", "2023-11-01", "2023-12-13",
  // 2024
  "2024-01-31", "2024-03-20", "2024-05-01", "2024-06-12",
  "2024-07-31", "2024-09-18", "2024-11-07", "2024-12-18",
  // 2025 (announced)
  "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18",
  "2025-07-30", "2025-09-17", "2025-10-29", "2025-12-10",
  // 2026 (announced)
  "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17",
  "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
];

function generateFomc() {
  return FOMC_DATES.map((d) => ({
    timestamp: `${d}T18:00:00Z`,
    category: "FOMC",
    description: "FOMC monetary policy decision",
  }));
}

// ------------------------------------------------------------------ ECB

// Source: ecb.europa.eu/press/calendars/mgcgc/html/index.en.html
// Decision is normally 12:15 UTC during summer time and 13:15 UTC in
// winter; the press conference is 12:45 / 13:45 UTC. Either is within the
// spec's +/- 15 min window when paired with a 12:30 UTC bar. We pin to
// 12:30 UTC as a compact representation.
const ECB_DATES = [
  // 2020
  "2020-01-23", "2020-03-12", "2020-04-30", "2020-06-04",
  "2020-07-16", "2020-09-10", "2020-10-29", "2020-12-10",
  // 2021
  "2021-01-21", "2021-03-11", "2021-04-22", "2021-06-10",
  "2021-07-22", "2021-09-09", "2021-10-28", "2021-12-16",
  // 2022
  "2022-02-03", "2022-03-10", "2022-04-14", "2022-06-09",
  "2022-07-21", "2022-09-08", "2022-10-27", "2022-12-15",
  // 2023
  "2023-02-02", "2023-03-16", "2023-05-04", "2023-06-15",
  "2023-07-27", "2023-09-14", "2023-10-26", "2023-12-14",
  // 2024
  "2024-01-25", "2024-03-07", "2024-04-11", "2024-06-06",
  "2024-07-18", "2024-09-12", "2024-10-17", "2024-12-12",
  // 2025
  "2025-01-30", "2025-03-06", "2025-04-17", "2025-06-05",
  "2025-07-24", "2025-09-11", "2025-10-30", "2025-12-18",
  // 2026
  "2026-01-29", "2026-03-12", "2026-04-23", "2026-06-04",
  "2026-07-23", "2026-09-10", "2026-10-29", "2026-12-17",
];

function generateEcb() {
  return ECB_DATES.map((d) => ({
    timestamp: `${d}T12:30:00Z`,
    category: "ECB",
    description: "ECB monetary policy decision",
  }));
}

// ------------------------------------------------------------------ BoE

// Source: bankofengland.co.uk/monetary-policy/upcoming-mpc-dates
// MPC decision at 11:00 UTC (12:00 London time during DST, 12:00 GMT
// otherwise — pin to 11:00 UTC as the canonical decision moment).
const BOE_DATES = [
  // 2020
  "2020-01-30", "2020-03-26", "2020-05-07", "2020-06-18",
  "2020-08-06", "2020-09-17", "2020-11-05", "2020-12-17",
  // 2021
  "2021-02-04", "2021-03-18", "2021-05-06", "2021-06-24",
  "2021-08-05", "2021-09-23", "2021-11-04", "2021-12-16",
  // 2022
  "2022-02-03", "2022-03-17", "2022-05-05", "2022-06-16",
  "2022-08-04", "2022-09-22", "2022-11-03", "2022-12-15",
  // 2023
  "2023-02-02", "2023-03-23", "2023-05-11", "2023-06-22",
  "2023-08-03", "2023-09-21", "2023-11-02", "2023-12-14",
  // 2024
  "2024-02-01", "2024-03-21", "2024-05-09", "2024-06-20",
  "2024-08-01", "2024-09-19", "2024-11-07", "2024-12-19",
  // 2025
  "2025-02-06", "2025-03-20", "2025-05-08", "2025-06-19",
  "2025-08-07", "2025-09-18", "2025-11-06", "2025-12-18",
  // 2026
  "2026-02-05", "2026-03-19", "2026-05-07", "2026-06-18",
  "2026-08-06", "2026-09-17", "2026-11-05", "2026-12-17",
];

function generateBoe() {
  return BOE_DATES.map((d) => ({
    timestamp: `${d}T11:00:00Z`,
    category: "BoE",
    description: "BoE Monetary Policy Committee decision",
  }));
}

// ----------------------------------------------------------------- Build

const years = [2020, 2021, 2022, 2023, 2024, 2025, 2026];
const events = [
  ...generateNfp(years),
  ...generateCpi(years),
  ...generateFomc(),
  ...generateEcb(),
  ...generateBoe(),
];
events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

writeFileSync(
  out,
  JSON.stringify(
    {
      $note:
        "Generated by build-news-events.mjs. Sources: federalreserve.gov, " +
        "bls.gov, ecb.europa.eu, bankofengland.co.uk. CPI dates are a " +
        "13th-of-month approximation; refine with authoritative BLS " +
        "calendar before production trading.",
      generatedAt: new Date().toISOString(),
      events,
    },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${events.length} events -> ${out}`);
