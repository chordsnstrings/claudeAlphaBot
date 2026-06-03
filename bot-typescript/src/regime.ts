// regime.ts — Parameter-light regime committee (eth_engine.recommended port).
// Returns a single signed position in [-1, 1] for the regime sleeve at the latest bar.

import { Bar } from "./types";
import { closes, sma, pctChange } from "./indicators";

type Regime = "sma" | "mom";

/** Evaluate one rule. Returns the rule's position contribution at index `i`. */
function evalRule(
  c: number[],
  smaArrs: Map<number, number[]>,
  momArrs: Map<number, number[]>,
  regime: Regime,
  regLb: number,
  momLb: number,
  bull: "hold" | "trend",
  bear: "short",
  shortW: number,
  longW: number,
  i: number,
): number {
  if (i < Math.max(regLb, momLb)) return 0;
  let isBull = false;
  if (regime === "sma") {
    const s = smaArrs.get(regLb)![i];
    if (isNaN(s)) return 0;
    isBull = c[i] > s;
  } else {
    const m = momArrs.get(regLb)![i];
    if (isNaN(m)) return 0;
    isBull = m > 0;
  }
  const fast = momArrs.get(momLb)![i];
  if (isNaN(fast)) return 0;

  if (isBull) {
    if (bull === "hold") return longW;
    // trend: long only on positive fast
    return fast > 0 ? longW : 0;
  }
  // bear: short on weakness
  return fast < 0 ? -shortW : 0;
}

/** Recommended ETH-style committee: 0.6 * hold-committee + 0.4 * trend-committee.
 * 32 sub-rules total (16 each). Returns position in [-1, 1] at the latest daily bar. */
export function regimePosition(dailyBars: Bar[]): number {
  const n = dailyBars.length;
  if (n < 210) return 0; // need history for SMA200 + momentum

  const c = closes(dailyBars);

  // Precompute the SMAs and momentums we need
  const regLbs = [50, 100, 150, 200];
  const momLbs = [20, 40];
  const smaArrs = new Map<number, number[]>();
  const momArrs = new Map<number, number[]>();
  for (const lb of regLbs) smaArrs.set(lb, sma(c, lb));
  for (const lb of [...regLbs, ...momLbs])
    momArrs.set(lb, pctChange(c, lb));

  const i = n - 1;
  const holdRules: number[] = [];
  const trendRules: number[] = [];

  for (const regime of ["sma", "mom"] as Regime[]) {
    for (const regLb of regLbs) {
      for (const momLb of momLbs) {
        // HOLD committee: 0.5x short on weakness in bear, hold in bull
        holdRules.push(
          evalRule(c, smaArrs, momArrs, regime, regLb, momLb, "hold", "short", 0.5, 1.0, i),
        );
        // TREND committee: 1.0x short on weakness in bear, long on strength in bull
        trendRules.push(
          evalRule(c, smaArrs, momArrs, regime, regLb, momLb, "trend", "short", 1.0, 1.0, i),
        );
      }
    }
  }

  const holdAvg = holdRules.reduce((a, b) => a + b, 0) / holdRules.length;
  const trendAvg = trendRules.reduce((a, b) => a + b, 0) / trendRules.length;
  return 0.6 * holdAvg + 0.4 * trendAvg;
}

/** Compute a series of daily regime positions (for vol-targeting). */
export function regimePositionSeries(dailyBars: Bar[]): number[] {
  const n = dailyBars.length;
  const out: number[] = new Array(n).fill(0);
  if (n < 210) return out;
  const c = closes(dailyBars);
  const regLbs = [50, 100, 150, 200];
  const momLbs = [20, 40];
  const smaArrs = new Map<number, number[]>();
  const momArrs = new Map<number, number[]>();
  for (const lb of regLbs) smaArrs.set(lb, sma(c, lb));
  for (const lb of [...regLbs, ...momLbs])
    momArrs.set(lb, pctChange(c, lb));

  for (let i = 210; i < n; i++) {
    const holdRules: number[] = [];
    const trendRules: number[] = [];
    for (const regime of ["sma", "mom"] as Regime[]) {
      for (const regLb of regLbs) {
        for (const momLb of momLbs) {
          holdRules.push(
            evalRule(c, smaArrs, momArrs, regime, regLb, momLb, "hold", "short", 0.5, 1.0, i),
          );
          trendRules.push(
            evalRule(c, smaArrs, momArrs, regime, regLb, momLb, "trend", "short", 1.0, 1.0, i),
          );
        }
      }
    }
    const holdAvg = holdRules.reduce((a, b) => a + b, 0) / holdRules.length;
    const trendAvg = trendRules.reduce((a, b) => a + b, 0) / trendRules.length;
    out[i] = 0.6 * holdAvg + 0.4 * trendAvg;
  }
  return out;
}
