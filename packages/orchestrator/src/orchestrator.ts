/**
 * Orchestrator — multi-strategy aggregation per spec §11.
 *
 * Three modes (constructor-selected):
 *
 *   "equal_weight"    : 1/N allocation per strategy.
 *   "risk_parity"     : 1/vol allocation, normalised. Rebalances on
 *                       quarter boundaries using a per-strategy rolling
 *                       60-day return series tracked via observeClose().
 *                       Strategies with <60 days of returns fall back
 *                       to 1/N for that strategy (per spec edge case).
 *   "regime_switched" : allocations come from {trend, meanRev, breakout}
 *                       buckets per the current Regime, which the engine
 *                       must update by calling setRegime(). Strategies
 *                       are bucketed via `strategyCategory(name)`.
 *
 * For all modes:
 *   process(signals, ctx) -> OrderRequest[]
 *     - Filters signals from strategies with allocation 0.
 *     - Scales each signal's `proposedSizeFractionOfAllocation` by the
 *       per-strategy allocation, recorded on the OrderRequest metadata
 *       as `orchestratorAllocation`.
 *     - One OrderRequest per allowed signal.
 *
 * Position-level reconciliation (when two strategies hold opposite
 * positions in the same instrument) is a follow-up; the spec acknowledges
 * "internal accounting preserves per-strategy positions" without
 * mandating broker-level netting.
 */

import { randomUUID } from "node:crypto";

import type {
  OrchestratorContext,
  Orchestrator as OrchestratorIface,
  OrderRequest,
  Signal,
} from "@trading/core";

import {
  REGIME_ALLOCATIONS,
  type Regime,
  type StrategyCategory,
} from "./regime-classifier.js";

export type OrchestratorMode = "equal_weight" | "risk_parity" | "regime_switched";

export interface OrchestratorStrategyMeta {
  name: string;
  category: StrategyCategory;
}

export interface OrchestratorOpts {
  mode: OrchestratorMode;
  strategies: readonly OrchestratorStrategyMeta[];
  /** Default lot size if the orchestrator can't derive one from a signal. */
  defaultLotSize?: number;
}

interface ReturnSample {
  ts: number;
  returnPct: number;
}

const ONE_DAY_MS = 86_400_000;
const SIXTY_DAYS_MS = 60 * ONE_DAY_MS;

export class Orchestrator implements OrchestratorIface {
  private readonly strategies: OrchestratorStrategyMeta[];
  private readonly defaultLotSize: number;
  private readonly mode: OrchestratorMode;
  private currentRegime: Regime = "mixed";
  private readonly returnHistory = new Map<string, ReturnSample[]>();
  /** Quarter-key (YYYY-Q) -> per-strategy allocation snapshot. */
  private rpQuarter: string | null = null;
  private rpAllocations: Map<string, number> = new Map();

  constructor(opts: OrchestratorOpts) {
    this.mode = opts.mode;
    this.strategies = [...opts.strategies];
    this.defaultLotSize = opts.defaultLotSize ?? 0.1;
  }

  /** Engine hook: pushes a per-strategy realised return for risk parity. */
  observeClose(strategy: string, returnPct: number, at: Date = new Date()): void {
    const hist = this.returnHistory.get(strategy) ?? [];
    hist.push({ ts: at.getTime(), returnPct });
    // Trim to 60 days.
    const cutoff = at.getTime() - SIXTY_DAYS_MS;
    while (hist.length > 0 && (hist[0]?.ts ?? 0) < cutoff) {
      hist.shift();
    }
    this.returnHistory.set(strategy, hist);
  }

  /** Engine hook for regime-switched mode. Call daily from EURUSD-daily. */
  setRegime(regime: Regime): void {
    this.currentRegime = regime;
  }

  /** For tests + UI: snapshot the current allocation per strategy. */
  allocations(at: Date = new Date()): Map<string, number> {
    return this.computeAllocations(at);
  }

  process(signals: Signal[], _ctx: OrchestratorContext): OrderRequest[] {
    if (signals.length === 0) {
      return [];
    }
    const at = signals[0]?.generatedAtBar ?? new Date();
    const allocs = this.computeAllocations(at);
    const out: OrderRequest[] = [];
    for (const s of signals) {
      const alloc = allocs.get(s.originatingStrategy) ?? 0;
      if (alloc <= 0) {
        continue;
      }
      // Scale the signal's intended size by the strategy's allocation.
      const lots = this.defaultLotSize * s.proposedSizeFractionOfAllocation * alloc;
      out.push({
        clientOrderId: randomUUID(),
        signal: s,
        instrument: s.instrument,
        direction: s.direction,
        orderType: "market",
        lotSize: Math.max(0.01, Math.round(lots * 100) / 100),
        price: null,
        stopPrice: s.proposedStopPrice,
        targetPrice: s.proposedTargetPrice,
        originatingStrategy: s.originatingStrategy,
        metadata: {
          orchestratorMode: this.mode,
          orchestratorAllocation: alloc,
          regime: this.mode === "regime_switched" ? this.currentRegime : null,
        },
      });
    }
    return out;
  }

  // ------------------------------------------------------- internal helpers

  private computeAllocations(at: Date): Map<string, number> {
    if (this.strategies.length === 0) {
      return new Map();
    }
    if (this.mode === "equal_weight") {
      return this.equalWeight();
    }
    if (this.mode === "risk_parity") {
      return this.riskParity(at);
    }
    return this.regimeSwitched();
  }

  private equalWeight(): Map<string, number> {
    const each = 1 / this.strategies.length;
    return new Map(this.strategies.map((s) => [s.name, each]));
  }

  private riskParity(at: Date): Map<string, number> {
    const qKey = quarterKey(at);
    if (qKey === this.rpQuarter && this.rpAllocations.size > 0) {
      return this.rpAllocations;
    }
    const vols: Array<{ name: string; vol: number }> = [];
    for (const s of this.strategies) {
      const hist = this.returnHistory.get(s.name) ?? [];
      const vol = sampleStddev(hist.map((h) => h.returnPct));
      vols.push({ name: s.name, vol });
    }
    // Strategies with <60 days of returns (vol === 0 from too-few samples)
    // fall back to equal weight for that strategy. We approximate "60 days"
    // with "at least 20 samples"; the engine will populate over time.
    const N = this.strategies.length;
    const inverseVols = vols.map((v) => {
      const hist = this.returnHistory.get(v.name) ?? [];
      if (hist.length < 20 || v.vol === 0) {
        return { name: v.name, weight: 1 / N };
      }
      return { name: v.name, weight: 1 / v.vol };
    });
    const sum = inverseVols.reduce((a, b) => a + b.weight, 0);
    const out = new Map<string, number>();
    for (const iv of inverseVols) {
      out.set(iv.name, sum > 0 ? iv.weight / sum : 1 / N);
    }
    this.rpQuarter = qKey;
    this.rpAllocations = out;
    return out;
  }

  private regimeSwitched(): Map<string, number> {
    const buckets = REGIME_ALLOCATIONS[this.currentRegime];
    // Distribute bucket weight equally among strategies in the bucket.
    const grouped = new Map<StrategyCategory, OrchestratorStrategyMeta[]>();
    for (const s of this.strategies) {
      const arr = grouped.get(s.category) ?? [];
      arr.push(s);
      grouped.set(s.category, arr);
    }
    const out = new Map<string, number>();
    for (const cat of Object.keys(buckets) as StrategyCategory[]) {
      const list = grouped.get(cat) ?? [];
      if (list.length === 0) {
        continue;
      }
      const share = buckets[cat] / list.length;
      for (const s of list) {
        out.set(s.name, share);
      }
    }
    // Strategies with no matching category get 0 allocation.
    for (const s of this.strategies) {
      if (!out.has(s.name)) {
        out.set(s.name, 0);
      }
    }
    return out;
  }
}

function quarterKey(at: Date): string {
  const y = at.getUTCFullYear();
  const q = Math.floor(at.getUTCMonth() / 3) + 1;
  return `${y}-Q${q}`;
}

function sampleStddev(xs: readonly number[]): number {
  if (xs.length < 2) {
    return 0;
  }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  let sq = 0;
  for (const x of xs) {
    const d = x - mean;
    sq += d * d;
  }
  return Math.sqrt(sq / (xs.length - 1));
}
