// config.ts — strategy + execution configuration from env
import "dotenv/config";

function n(key: string, def: number): number {
  const v = process.env[key];
  return v ? parseFloat(v) : def;
}
function b(key: string, def: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return def;
  return v.toLowerCase() === "true" || v === "1";
}
function s(key: string, def: string): string {
  return process.env[key] ?? def;
}

export const CONFIG = {
  // Safety
  PAPER: b("PAPER", true),
  DRY_RUN: b("DRY_RUN", true),

  // Exchange
  EXCHANGE: s("EXCHANGE", "binanceusdm"),
  API_KEY: s("EXCHANGE_API_KEY", ""),
  API_SECRET: s("EXCHANGE_API_SECRET", ""),
  USE_TESTNET: b("USE_TESTNET", true),

  // Strategy
  ASSET: s("ASSET", "ETH"),
  BASE_USD: n("BASE_USD", 10000),
  VOL_TARGET: n("VOL_TARGET", 0.30),
  LEV_CAP: n("LEV_CAP", 1.5),
  W_REGIME: n("W_REGIME", 0.25),
  W_POOL: n("W_POOL", 0.75),
  LEVERAGE_MULT: n("LEVERAGE_MULT", 1.0),
  HARVEST_DECAY: n("HARVEST_DECAY", 0.15),
  MAX_LEV_EXCHANGE: n("MAX_LEV_EXCHANGE", 10),

  // Pool config (parameter-light, validated by WF-OOS)
  POOL_DONCH_LENGTHS: [20, 50, 100],
  POOL_SMA_TREND: 200,
  POOL_ADX_MIN: 20,
  POOL_ATR_MULT: 2.0,
  POOL_RR: 2.0,                 // 2:1 reward:risk
  POOL_RISK_PER_BOOK: 0.02,     // 2% risk per book
  POOL_MAX_HOLD_HOURS: 24 * 60, // 60 days max

  // Execution
  LOOP_INTERVAL_SEC: n("LOOP_INTERVAL_SEC", 300),
  REBAL_BAND: n("REBAL_BAND", 0.05),

  // Internal — required historical bars
  MIN_DAILY_BARS: 300,          // for SMA200 + warmup
  MIN_4H_BARS: 400,             // for 200-bar SMA on 4h + ATR + ADX
  MIN_1H_BARS: 100,             // for resolution
};

export type Config = typeof CONFIG;

export function symbolFor(asset: string): string {
  return `${asset.toUpperCase()}/USDT:USDT`;  // perpetual futures symbol for ccxt
}
