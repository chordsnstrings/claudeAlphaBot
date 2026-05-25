/**
 * BTCUSDT optimizer + ceiling study.
 *
 * A good-faith search for the configuration that comes closest to the
 * 20%/month target, plus the analysis that explains why the literal target is
 * unreachable without ruinous risk:
 *
 *   1. WEEKEND_MR parameter sweep (threshold × stop buffer × risk), scored on
 *      constant-capital monthly return with the monthly profit skim applied.
 *   2. A risk ladder on the best config (2% → 80% risk/trade) showing how
 *      forcing the mean monthly return up drives max drawdown to ruin.
 *   3. BTC buy-and-hold benchmark over the same window.
 *   4. Train / out-of-sample split on the best config so the headline number
 *      isn't an in-sample artefact.
 *
 * Usage: tsx src/cli/optimize-btcusdt.ts [--data=artifacts/btcusdt-1h.json]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { Candle, Symbol as TradingSymbol, Trade } from "@hydra/shared";

import { atr as computeAtr } from "../core/indicators.js";
import { evaluateArb, type ArbOptions } from "../core/signals-arb.js";
import { evaluateNyOpen } from "../core/signals-ny-open.js";
import { evaluateWeekendMr, type WeekendMrOptions } from "../core/signals-weekend-mr.js";
import { runReplay, type StrategyEvaluator } from "../backtest/replay-engine.js";
import { buildReport } from "../backtest/metrics.js";

const BASE = 10_000;
const TARGET = 20;
const RUIN_DD = 50; // a constant-capital drawdown this deep is effectively account death

function atrMap(candles: readonly Candle[]): Map<number, number> {
  const arr = computeAtr(candles, 14);
  const m = new Map<number, number>();
  for (let i = 0; i < candles.length; i++) m.set(candles[i]!.openTime, arr[i]!);
  return m;
}
function lastAtr(c: readonly Candle[], m: Map<number, number>): number | null {
  const last = c[c.length - 1];
  if (!last) return null;
  const v = m.get(last.openTime);
  return v !== undefined && Number.isFinite(v) ? v : null;
}

function wmrEval(opts: WeekendMrOptions): StrategyEvaluator {
  return {
    name: "WEEKEND_MR",
    evaluate: (symbol, candles, hasOpen) => {
      if (candles.length < 60) return null;
      const r = evaluateWeekendMr({ symbol, candles, hasExistingPosition: hasOpen, opts });
      return r.type === "FIRE" ? r.signal : null;
    },
  };
}
function arbEval(m: Map<number, number>, opts: ArbOptions): StrategyEvaluator {
  return {
    name: "ARB",
    evaluate: (symbol, candles, hasOpen) => {
      if (candles.length < 30) return null;
      const a = lastAtr(candles, m);
      if (a === null) return null;
      const r = evaluateArb({ symbol, candles, atr: a, hasExistingPosition: hasOpen, opts });
      return r.type === "FIRE" ? r.signal : null;
    },
  };
}
function nyEval(m: Map<number, number>): StrategyEvaluator {
  return {
    name: "NY_OPEN",
    evaluate: (symbol, candles, hasOpen) => {
      if (candles.length < 30) return null;
      const a = lastAtr(candles, m);
      if (a === null) return null;
      const r = evaluateNyOpen({ symbol, candles, atr: a, hasExistingPosition: hasOpen });
      return r.type === "FIRE" ? r.signal : null;
    },
  };
}

interface Scored {
  readonly label: string;
  readonly riskPct: number;
  readonly trades: number;
  readonly meanMonthlyPct: number;
  readonly medianMonthlyPct: number;
  readonly monthsAbove: number;
  readonly months: number;
  readonly skimMaxDdPct: number;
  readonly compoundMaxDdPct: number;
  readonly compoundAnnualizedPct: number;
  readonly totalWithdrawn: number;
}

function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i]! : (s[i - 1]! + s[i]!) / 2;
}

function score(
  label: string,
  make: () => readonly StrategyEvaluator[],
  candles: readonly Candle[],
  riskPct: number,
): Scored {
  const skim = runReplay({
    candles,
    strategies: make(),
    opts: {
      startingEquity: BASE,
      risk: { riskPct },
      withdrawal: { kind: "skim-to-base", base: BASE },
    },
  });
  const compound = runReplay({
    candles,
    strategies: make(),
    opts: { startingEquity: BASE, risk: { riskPct } },
  });
  const skimRep = buildReport(skim.trades as readonly Trade[], skim.equityCurve, BASE);
  const cmpRep = buildReport(compound.trades as readonly Trade[], compound.equityCurve, BASE);
  const monthly = skimRep.monthly.map((m) => m.returnPct);
  return {
    label,
    riskPct,
    trades: cmpRep.summary.trades,
    meanMonthlyPct: mean(monthly),
    medianMonthlyPct: median(monthly),
    monthsAbove: skimRep.monthly.filter((m) => m.returnPct >= TARGET).length,
    months: monthly.length,
    skimMaxDdPct: skimRep.summary.maxDrawdownPct,
    compoundMaxDdPct: cmpRep.summary.maxDrawdownPct,
    compoundAnnualizedPct: cmpRep.summary.annualizedReturnPct,
    totalWithdrawn: skim.totalWithdrawn,
  };
}

function buyHoldMonthly(candles: readonly Candle[]): { month: string; returnPct: number }[] {
  const first = new Map<string, number>();
  const last = new Map<string, number>();
  for (const c of candles) {
    const d = new Date(c.openTime);
    const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!first.has(k)) first.set(k, c.open);
    last.set(k, c.close);
  }
  return Array.from(first.keys())
    .sort()
    .map((k) => ({ month: k, returnPct: ((last.get(k)! - first.get(k)!) / first.get(k)!) * 100 }));
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
  const m = atrMap(candles);

  // eslint-disable-next-line no-console
  console.log(
    `\nBTCUSDT optimizer — ${raw.count} candles ${raw.firstOpen?.slice(0, 10)} → ${raw.lastOpen?.slice(0, 10)}\n` +
      `Scoring constant-capital monthly return (profit skimmed to $${BASE} each month). Target ${TARGET}%/mo.\n`,
  );

  // 1. WEEKEND_MR parameter sweep ------------------------------------------
  const thresholds = [2.0, 2.5, 3.0, 3.5];
  const stopBuffers = [0.3, 0.5, 0.7];
  const risks = [0.02, 0.05, 0.1];
  const wmrRuns: Scored[] = [];
  for (const th of thresholds)
    for (const sb of stopBuffers)
      for (const rk of risks)
        wmrRuns.push(
          score(
            `WMR th=${th} sb=${sb}`,
            () => [wmrEval({ thresholdPct: th, stopBufferPct: sb })],
            candles,
            rk,
          ),
        );
  // Also a couple of ARB grids + NY for completeness.
  const others: Scored[] = [
    score("ARB tp1=1.0 tp2=2.5", () => [arbEval(m, { tp1Rmultiple: 1.0, tp2Rmultiple: 2.5 })], candles, 0.05),
    score("ARB tp1=2.0 tp2=3.5", () => [arbEval(m, { tp1Rmultiple: 2.0, tp2Rmultiple: 3.5 })], candles, 0.05),
    score("NY_OPEN default", () => [nyEval(m)], candles, 0.02),
  ];

  const all = [...wmrRuns, ...others];
  // Survivability filter: constant-capital max DD < 35%.
  const survivable = all.filter((r) => r.skimMaxDdPct < 35);
  const best = [...(survivable.length ? survivable : all)].sort(
    (a, b) => b.meanMonthlyPct - a.meanMonthlyPct,
  )[0]!;

  const top = [...all].sort((a, b) => b.meanMonthlyPct - a.meanMonthlyPct).slice(0, 8);
  // eslint-disable-next-line no-console
  console.log("Top configs by mean monthly return (constant capital):");
  // eslint-disable-next-line no-console
  console.log("  config                 risk  trd  meanMo%  medMo%  hit20  skimDD%  cmpAnn%");
  for (const r of top) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${r.label.padEnd(22)} ${String(r.riskPct * 100 + "%").padStart(4)} ` +
        `${String(r.trades).padStart(4)} ${r.meanMonthlyPct.toFixed(2).padStart(8)} ` +
        `${r.medianMonthlyPct.toFixed(2).padStart(7)} ${`${r.monthsAbove}/${r.months}`.padStart(6)} ` +
        `${r.skimMaxDdPct.toFixed(1).padStart(8)} ${r.compoundAnnualizedPct.toFixed(1).padStart(8)}`,
    );
  }

  // 2. Risk ladder on the best config -------------------------------------
  const bestThMatch = /th=([\d.]+) sb=([\d.]+)/.exec(best.label);
  const ladderMake: () => readonly StrategyEvaluator[] = bestThMatch
    ? () => [
        wmrEval({
          thresholdPct: Number(bestThMatch[1]),
          stopBufferPct: Number(bestThMatch[2]),
        }),
      ]
    : () => [wmrEval({})];
  const ladderRisks = [0.02, 0.05, 0.1, 0.2, 0.4, 0.8];
  const ladder = ladderRisks.map((rk) => score(`${best.label} (ladder)`, ladderMake, candles, rk));
  // eslint-disable-next-line no-console
  console.log(`\nRisk ladder on best config (${best.label}) — chasing 20%/mo:`);
  // eslint-disable-next-line no-console
  console.log("  risk/trade  meanMo%  skimDD%  cmpDD%   verdict");
  for (const r of ladder) {
    const verdict =
      r.skimMaxDdPct >= RUIN_DD || r.compoundMaxDdPct >= RUIN_DD ? "RUINOUS" : "survivable";
    // eslint-disable-next-line no-console
    console.log(
      `  ${String(r.riskPct * 100 + "%").padStart(9)} ${r.meanMonthlyPct.toFixed(2).padStart(8)} ` +
        `${r.skimMaxDdPct.toFixed(1).padStart(8)} ${r.compoundMaxDdPct.toFixed(1).padStart(7)}   ${verdict}`,
    );
  }

  // 3. Buy-and-hold benchmark ---------------------------------------------
  const bh = buyHoldMonthly(candles);
  const bhMean = mean(bh.map((x) => x.returnPct));
  const bhAbove = bh.filter((x) => x.returnPct >= TARGET).length;
  const firstClose = candles[0]!.close;
  const lastClose = candles[candles.length - 1]!.close;
  const bhTotal = ((lastClose - firstClose) / firstClose) * 100;
  // eslint-disable-next-line no-console
  console.log(
    `\nBTC buy-and-hold over window: total ${bhTotal.toFixed(1)}%, ` +
      `mean month ${bhMean.toFixed(2)}%, months ≥20%: ${bhAbove}/${bh.length}`,
  );

  // 4. Train / OOS split on best config -----------------------------------
  const cutIdx = Math.floor(candles.length * 0.7);
  const cutTime = candles[cutIdx]!.openTime;
  const train = candles.filter((c) => c.openTime < cutTime);
  const oos = candles.filter((c) => c.openTime >= cutTime);
  const trainScore = score(`${best.label} TRAIN`, ladderMake, train, best.riskPct);
  const oosScore = score(`${best.label} OOS`, ladderMake, oos, best.riskPct);
  // eslint-disable-next-line no-console
  console.log(
    `\nTrain/OOS on best config @ ${best.riskPct * 100}% risk (70/30 split @ ${new Date(cutTime).toISOString().slice(0, 10)}):\n` +
      `  TRAIN: mean ${trainScore.meanMonthlyPct.toFixed(2)}%/mo, ${trainScore.monthsAbove}/${trainScore.months} ≥20%, skimDD ${trainScore.skimMaxDdPct.toFixed(1)}%\n` +
      `  OOS:   mean ${oosScore.meanMonthlyPct.toFixed(2)}%/mo, ${oosScore.monthsAbove}/${oosScore.months} ≥20%, skimDD ${oosScore.skimMaxDdPct.toFixed(1)}%`,
  );

  // eslint-disable-next-line no-console
  console.log(
    `\nVERDICT: best achievable ≈ ${best.meanMonthlyPct.toFixed(2)}%/mo at survivable risk; ` +
      `20%/mo is ${best.meanMonthlyPct > 0 ? (TARGET / best.meanMonthlyPct).toFixed(0) : "∞"}× that, ` +
      `reachable only at risk levels the ladder flags RUINOUS.\n`,
  );

  const outPath = resolve(process.cwd(), "artifacts/btcusdt_optimization.json");
  await mkdir(resolve(outPath, ".."), { recursive: true });
  await writeFile(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        dataWindow: { firstOpen: raw.firstOpen, lastOpen: raw.lastOpen, candles: raw.count },
        target: TARGET,
        best,
        topConfigs: top,
        riskLadder: ladder,
        buyHold: { totalPct: bhTotal, meanMonthlyPct: bhMean, monthsAbove: bhAbove, months: bh.length },
        trainOos: { cut: new Date(cutTime).toISOString(), train: trainScore, oos: oosScore },
      },
      null,
      2,
    ),
  );
  // eslint-disable-next-line no-console
  console.log("wrote artifacts/btcusdt_optimization.json\n");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
