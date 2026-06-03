// types.ts — shared types

export type Bar = {
  openMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type Timeframe = "1h" | "4h" | "1d";

// Single open pool position (one "book" in a concurrent-books pool)
export type Book = {
  donchN: number;             // which Donchian length triggered this entry
  direction: 1 | -1;           // long = 1, short = -1
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  notional: number;            // notional dollars at entry
  openMs: number;              // entry timestamp
};

export type StrategyState = {
  // Persisted bot state across restarts
  initialized: boolean;
  baseUsd: number;
  walletUsd: number;           // trading wallet
  spotUsd: number;             // harvested cash (or 'spot' alt holdings)
  walletPeak: number;          // for ATH-decay harvest
  openBooks: Book[];           // open pool positions
  lastHourMs: number;          // last hour we processed (avoid double-processing)
  lastTradeMs: number;
};
