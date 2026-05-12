/** @trading/engine — TradingSystem event loop + composition root. */

export const PACKAGE_NAME = "@trading/engine";

export { TradingSystem, emptyPositionEvents } from "./trading-system.js";
export { buildSystem, registerAdapters } from "./build-system.js";
export type { TradingSystemDeps, PerBarStats } from "./types.js";
export { isCompleteBar, barKey } from "./types.js";
