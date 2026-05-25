/**
 * BTCUSDT strategy study — answers the question:
 *   "Which of the bot's strategies best targets 20% month-on-month on
 *    BTCUSDT, with all profit above the base withdrawn every month?"
 *
 * Loads cached real BTCUSDT 1h candles (see fetch-btc-data.ts), runs each
 * implementable strategy (ARB, NY_OPEN, WEEKEND_MR) and an all-three
 * portfolio through the deterministic replay engine at several risk-per-trade
 * levels, in two accounting modes:
 *   - COMPOUND  — profit is left in the account (context / upper bound).
 *   - SKIM      — at each UTC month boundary every dollar above the 10k base
 *                 is withdrawn, so working capital stays constant (the goal's
 *                 "take the extra out each month" rule).
 *
 * Reports per run: monthly-return distribution, how many months clear +20%,
 * total withdrawn, max drawdown, Sharpe. Writes a JSON artifact and prints a
 * ranked summary. No DB, no network (after the one-off data fetch).
 *
 * Usage: tsx src/cli/analyze-btcusdt.ts [--data=artifacts/btcusdt-1h.json]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { Candle, Symbol as TradingSymbol, Trade } from "@hydra/shared";

import { atr as computeAtr } from "../core/indicators.js";
import { evaluateArb } from "../core/signals-arb.js";
import { evaluateNyOpen } from "../core/signals-ny-open.js";
import { evaluateWeekendMr } from "../core/signals-weekend-mr.js";
import { runReplay, type StrategyEvaluator } from "../backtest/replay-engine.js";
import { buildReport, type MonthlyRow } from "../backtest/metrics.js";

const BASE_EQUITY = 10_000;
const TARGET_MONTHLY_PCT = 20;
const RISK_LEVELS = [0.02, 0.05, 0.1] as const;

/** ATR(14) keyed by candle openTime, precomputed once over the full series. */
function buildAtrMap(candles: readonly Candle[]): Map<number, number> {
  const arr = computeAtr(candles, 14);
  const m = new Map<number, number>();
  for (let i = 0; i < candles.length; i++) m.set(candles[i]!.openTime, arr[i]!);
  return m;
}

function lastAtr(candles: readonly Candle[], atrByTime: Map<number, number>): number | null {
  const last = candles[candles.length - 1];
  if (!last) return null;
  const v = atrByTime.get(last.openTime);
  return v !== undefined && Number.isFinite(v) ? v : null;
}

function arbEvaluator(atrByTime: Map<number, number>): StrategyEvaluator {
  return {
    name: "ARB",
    evaluate(symbol, candles, hasOpenPosition) {
      if (candles.length < 30) return null;
      const a = lastAtr(candles, atrByTime);
      if (a === null) return null;
      const r = evaluateArb({ symbol, candles, atr: a, hasExistingPosition: hasOpenPosition });
      return r.type === "FIRE" ? r.signal : null;
    },
  };
}

function nyOpenEvaluator(atrByTime: Map<number, number>): StrategyEvaluator {
  return {
    name: "NY_OPEN",
    evaluate(symbol, candles, hasOpenPosition) {
      if (candles.length < 30) return null;
      const a = lastAtr(candles, atrByTime);
      if (a === null) return null;
      const r = evaluateNyOpen({ symbol, candles, atr: a, hasExistingPosition: hasOpenPosition });
      return r.type === "FIRE" ? r.signal : null;
    },
  };
}

function weekendMrEvaluator(): StrategyEvaluator {
  return {
    name: "WEEKEND_MR",
    evaluate(symbol, candles, hasOpenPosition) {
      if (candles.length < 60) return null;
      const r = evaluateWeekendMr({ symbol, candles, hasExistingPosition: hasOpenPosition });
      return r.type === "FIRE" ? r.signal : null;
    },
  };
}

interface StrategyDef {
  readonly label: string;
  readonly make: (atrByTime: Map<number, number>) => readonly StrategyEvaluator[];
}

const STRATEGIES: readonly StrategyDef[] = [
  { label: "ARB", make: (a) => [arbEvaluator(a)] },
  { label: "NY_OPEN", make: (a) => [nyOpenEvaluator(a)] },
  { label: "WEEKEND_MR", make: () => [weekendMrEvaluator()] },
  {
    label: "PORTFOLIO(ARB+NY+WMR)",
    make: (a) => [arbEvaluator(a), nyOpenEvaluator(a), weekendMrEvaluator()],
  },
];

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

interface RunResult {
  readonly strategy: string;
  readonly riskPct: number;
  readonly trades: number;
  readonly winRatePct: number;
  // COMPOUND view
  readonly compoundTotalReturnPct: number;
  readonly compoundAnnualizedPct: number;
  readonly compoundMaxDdPct: number;
  readonly sharpe: number;
  // SKIM (constant-capital) view
  readonly months: number;
  readonly medianMonthlyPct: number;
  readonly meanMonthlyPct: number;
  readonly bestMonthlyPct: number;
  readonly worstMonthlyPct: number;
  readonly monthsAboveTarget: number;
  readonly hitRatePct: number;
  readonly totalWithdrawn: number;
  readonly withdrawnPctOfBase: number;
  readonly skimMaxDdPct: number;
  readonly monthlyRows: readonly MonthlyRow[];
}

function runOne(
  def: StrategyDef,
  candles: readonly Candle[],
  riskPct: number,
  atrByTime: Map<number, number>,
): RunResult {
  const compound = runReplay({
    candles,
    strategies: def.make(atrByTime),
    opts: { startingEquity: BASE_EQUITY, risk: { riskPct } },
  });
  const skim = runReplay({
    candles,
    strategies: def.make(atrByTime),
    opts: {
      startingEquity: BASE_EQUITY,
      risk: { riskPct },
      withdrawal: { kind: "skim-to-base", base: BASE_EQUITY },
    },
  });

  const compoundReport = buildReport(
    compound.trades as readonly Trade[],
    compound.equityCurve,
    BASE_EQUITY,
  );
  const skimReport = buildReport(skim.trades as readonly Trade[], skim.equityCurve, BASE_EQUITY);

  const monthly = skimReport.monthly;
  const monthlyReturns = monthly.map((m) => m.returnPct);
  const monthsAbove = monthly.filter((m) => m.returnPct >= TARGET_MONTHLY_PCT).length;

  return {
    strategy: def.label,
    riskPct,
    trades: compoundReport.summary.trades,
    winRatePct: compoundReport.summary.winRatePct,
    compoundTotalReturnPct: compoundReport.summary.totalReturnPct,
    compoundAnnualizedPct: compoundReport.summary.annualizedReturnPct,
    compoundMaxDdPct: compoundReport.summary.maxDrawdownPct,
    sharpe: compoundReport.summary.sharpe,
    months: monthly.length,
    medianMonthlyPct: median(monthlyReturns),
    meanMonthlyPct: mean(monthlyReturns),
    bestMonthlyPct: monthlyReturns.length ? Math.max(...monthlyReturns) : 0,
    worstMonthlyPct: monthlyReturns.length ? Math.min(...monthlyReturns) : 0,
    monthsAboveTarget: monthsAbove,
    hitRatePct: monthly.length ? (monthsAbove / monthly.length) * 100 : 0,
    totalWithdrawn: skim.totalWithdrawn,
    withdrawnPctOfBase: (skim.totalWithdrawn / BASE_EQUITY) * 100,
    skimMaxDdPct: skimReport.summary.maxDrawdownPct,
    monthlyRows: monthly,
  };
}

function fmt(n: number, d = 1): string {
  return n.toFixed(d);
}

async function main(): Promise<void> {
  const dataArg = process.argv.slice(2).find((a) => a.startsWith("--data="));
  const dataPath = dataArg ? dataArg.slice("--data=".length) : "artifacts/btcusdt-1h.json";
  const raw = JSON.parse(await readFile(resolve(process.cwd(), dataPath), "utf8")) as {
    candles: Candle[];
    firstOpen: string;
    lastOpen: string;
    count: number;
  };
  const candles = raw.candles.map((c) => ({ ...c, symbol: "BTCUSDT" as TradingSymbol }));

  // eslint-disable-next-line no-console
  console.log(
    `\nBTCUSDT 1h — ${raw.count} candles, ${raw.firstOpen?.slice(0, 10)} → ${raw.lastOpen?.slice(0, 10)}\n` +
      `Base capital ${BASE_EQUITY}, target ${TARGET_MONTHLY_PCT}%/month, profit skimmed to base monthly.\n`,
  );

  const atrByTime = buildAtrMap(candles);
  const results: RunResult[] = [];
  for (const def of STRATEGIES) {
    for (const risk of RISK_LEVELS) {
      results.push(runOne(def, candles, risk, atrByTime));
    }
  }

  // Print table.
  const hdr = [
    "strategy".padEnd(22),
    "risk".padStart(5),
    "trd".padStart(4),
    "win%".padStart(5),
    "medMo%".padStart(7),
    "meanMo%".padStart(8),
    "best%".padStart(6),
    "worst%".padStart(7),
    "hit20".padStart(6),
    "skimDD%".padStart(8),
    "cmpAnn%".padStart(9),
    "cmpDD%".padStart(7),
  ].join(" ");
  // eslint-disable-next-line no-console
  console.log(hdr);
  // eslint-disable-next-line no-console
  console.log("-".repeat(hdr.length));
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(
      [
        r.strategy.padEnd(22),
        `${fmt(r.riskPct * 100, 0)}%`.padStart(5),
        String(r.trades).padStart(4),
        fmt(r.winRatePct, 0).padStart(5),
        fmt(r.medianMonthlyPct).padStart(7),
        fmt(r.meanMonthlyPct).padStart(8),
        fmt(r.bestMonthlyPct).padStart(6),
        fmt(r.worstMonthlyPct).padStart(7),
        `${r.monthsAboveTarget}/${r.months}`.padStart(6),
        fmt(r.skimMaxDdPct).padStart(8),
        fmt(r.compoundAnnualizedPct, 0).padStart(9),
        fmt(r.compoundMaxDdPct, 0).padStart(7),
      ].join(" "),
    );
  }

  // Rank: best = highest mean monthly return (constant-capital) among runs whose
  // skim-mode max drawdown stays under 35% — survivability matters for a
  // withdraw-everything mandate. Fall back to raw mean if none qualify.
  const survivable = results.filter((r) => r.skimMaxDdPct < 35);
  const pool = survivable.length ? survivable : results;
  const best = [...pool].sort((a, b) => b.meanMonthlyPct - a.meanMonthlyPct)[0]!;

  // eslint-disable-next-line no-console
  console.log(
    `\nBest goal-aligned run: ${best.strategy} @ risk ${fmt(best.riskPct * 100, 0)}%/trade\n` +
      `  median month ${fmt(best.medianMonthlyPct)}%, mean ${fmt(best.meanMonthlyPct)}%, ` +
      `months ≥20%: ${best.monthsAboveTarget}/${best.months} (${fmt(best.hitRatePct, 0)}%)\n` +
      `  total withdrawn over window: $${fmt(best.totalWithdrawn, 0)} ` +
      `(${fmt(best.withdrawnPctOfBase, 0)}% of base), skim max DD ${fmt(best.skimMaxDdPct)}%\n`,
  );

  const outPath = resolve(process.cwd(), "artifacts/btcusdt_strategy_analysis.json");
  await mkdir(resolve(outPath, ".."), { recursive: true });
  await writeFile(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        dataWindow: { firstOpen: raw.firstOpen, lastOpen: raw.lastOpen, candles: raw.count },
        baseEquity: BASE_EQUITY,
        targetMonthlyPct: TARGET_MONTHLY_PCT,
        riskLevels: RISK_LEVELS,
        best: {
          strategy: best.strategy,
          riskPct: best.riskPct,
          medianMonthlyPct: best.medianMonthlyPct,
          meanMonthlyPct: best.meanMonthlyPct,
          monthsAboveTarget: best.monthsAboveTarget,
          months: best.months,
          totalWithdrawn: best.totalWithdrawn,
          skimMaxDdPct: best.skimMaxDdPct,
        },
        runs: results,
      },
      null,
      2,
    ),
  );
  // eslint-disable-next-line no-console
  console.log(`wrote artifacts/btcusdt_strategy_analysis.json\n`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
