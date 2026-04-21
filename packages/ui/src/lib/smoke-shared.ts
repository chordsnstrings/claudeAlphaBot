/**
 * Import-smoke file: verifies @hydra/shared types are consumable
 * from the UI workspace. Used by tsc reference graph; expanded in Phase 15.
 */
import { SYMBOLS, STRATEGIES, type Trade, type OpenPosition, type BotStatus } from "@hydra/shared";

export const ALL_SYMBOLS = SYMBOLS;
export const ALL_STRATEGIES = STRATEGIES;

export type UiTrade = Trade;
export type UiPosition = OpenPosition;
export type UiStatus = BotStatus;
