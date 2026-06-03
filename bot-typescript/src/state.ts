// state.ts — persist bot state to a JSON file on disk so restarts don't lose it.

import * as fs from "fs";
import * as path from "path";
import { StrategyState } from "./types";
import { CONFIG } from "./config";

const STATE_PATH = path.join(process.cwd(), ".bot-state.json");

export function loadState(): StrategyState {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const raw = fs.readFileSync(STATE_PATH, "utf-8");
      return JSON.parse(raw) as StrategyState;
    }
  } catch (e) {
    console.warn("Failed to load state:", e);
  }
  return {
    initialized: false,
    baseUsd: CONFIG.BASE_USD,
    walletUsd: CONFIG.BASE_USD,
    spotUsd: 0,
    walletPeak: CONFIG.BASE_USD,
    openBooks: [],
    lastHourMs: 0,
    lastTradeMs: 0,
  };
}

export function saveState(state: StrategyState): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
