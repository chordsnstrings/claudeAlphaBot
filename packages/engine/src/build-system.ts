/**
 * Composition root per spec §1.4.
 *
 * Selects adapters by mode and constructs the TradingSystem. The actual
 * adapter implementations land in later phases:
 *
 *   HistoricalDataFeed         — Phase 6
 *   SimulatedExecutionAdapter  — Phase 7
 *   SimulatedClock             — Phase 8
 *   CTraderDataFeed            — Phase 15
 *   CTraderExecutionAdapter    — Phase 16
 *   SystemClock                — Phase 17
 *
 * Until those land, calling `buildSystem(config)` throws a clear error
 * identifying the missing piece. Direct construction of TradingSystem
 * with injected adapters works today (the integration test does this).
 */

import {
  logger,
  type SystemConfig,
} from "@trading/core";

import { TradingSystem } from "./trading-system.js";
import type { TradingSystemDeps } from "./types.js";

const log = logger("engine.build");

/** Class registry filled in by later phases via `registerAdapters()`. */
interface AdapterFactories {
  buildBacktest?: (config: SystemConfig) => Promise<TradingSystemDeps>;
  buildLive?: (config: SystemConfig) => Promise<TradingSystemDeps>;
}

const factories: AdapterFactories = {};

/**
 * Register the adapter-construction functions used by `buildSystem`. Called
 * from the deployment entrypoint after all adapter packages are imported.
 */
export function registerAdapters(reg: AdapterFactories): void {
  if (reg.buildBacktest !== undefined) {
    factories.buildBacktest = reg.buildBacktest;
  }
  if (reg.buildLive !== undefined) {
    factories.buildLive = reg.buildLive;
  }
}

export async function buildSystem(config: SystemConfig): Promise<TradingSystem> {
  log.info(
    {
      mode: config.mode,
      sessionId: config.sessionId,
      strategies: config.strategies.map((s) => s.name),
      orchestratorMode: config.orchestratorMode,
    },
    "building trading system",
  );

  if (config.mode === "backtest") {
    if (factories.buildBacktest === undefined) {
      throw new Error(
        "buildSystem(backtest): no backtest adapter factory registered. " +
          "Phase 6 (HistoricalDataFeed) + Phase 7 (SimulatedExecutionAdapter) + " +
          "Phase 8 (SimulatedClock) must call registerAdapters() before this.",
      );
    }
    const deps = await factories.buildBacktest(config);
    return new TradingSystem(deps);
  }

  if (factories.buildLive === undefined) {
    throw new Error(
      "buildSystem(live): no live adapter factory registered. " +
        "Phase 15 (CTraderDataFeed) + Phase 16 (CTraderExecutionAdapter) + " +
        "Phase 17 (SystemClock) must call registerAdapters() before this.",
    );
  }
  const deps = await factories.buildLive(config);
  return new TradingSystem(deps);
}
