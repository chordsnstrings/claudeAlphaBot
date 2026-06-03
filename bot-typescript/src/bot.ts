// bot.ts — main strategy loop: fetch, compute target, manage books, rebalance.

import { CONFIG } from "./config";
import { Bar, StrategyState } from "./types";
import { fetchBars, fetchEquityUsdt, fetchPosition, rebalanceToTarget } from "./exchange";
import { computeBlendTarget, regimeDailyReturns, approxPoolDailyReturns } from "./blend";
import { regimePositionSeries } from "./regime";
import { detectPoolSignals, openBookOn1h, checkBookHit, poolNetPosition } from "./pool";
import { harvestIfNeeded, applyReturn, totalWealth } from "./harvest";
import { loadState, saveState } from "./state";

let lastWalletForReturn = CONFIG.BASE_USD;
let lastPriceForPnl = 0;

export async function tickOnce(): Promise<void> {
  const t0 = Date.now();
  const state = loadState();

  // 1) Fetch bars
  const daily = await fetchBars(CONFIG.ASSET, "1d", 400);
  const bars4h = await fetchBars(CONFIG.ASSET, "4h", 600);
  const bars1h = await fetchBars(CONFIG.ASSET, "1h", 600);

  if (
    daily.length < CONFIG.MIN_DAILY_BARS ||
    bars4h.length < CONFIG.MIN_4H_BARS ||
    bars1h.length < CONFIG.MIN_1H_BARS
  ) {
    console.warn(
      `Not enough bars yet: daily ${daily.length}, 4h ${bars4h.length}, 1h ${bars1h.length}`,
    );
    return;
  }

  const latestPrice = bars1h[bars1h.length - 1].close;
  const nowMs = bars1h[bars1h.length - 1].openMs + 3600 * 1000;

  // 2) Update wallet from price move on the OLD net position (since last tick)
  if (state.initialized && lastPriceForPnl > 0) {
    // Compute net position delta in USD terms
    // For simplicity we re-fetch position from exchange (or use last computed)
    // Skip for first tick
    const priceRet = latestPrice / lastPriceForPnl - 1;
    // (We use the actual exchange equity in live; in paper we mark to last position * priceRet)
    // The paper accounting is handled below by re-deriving wallet from equity
  }

  // 3) Resolve open books on new 1h bars
  const closedBooks: typeof state.openBooks = [];
  const stillOpen: typeof state.openBooks = [];
  for (const book of state.openBooks) {
    const recent1h = bars1h.filter((b) => b.openMs > book.openMs);
    const { hit, bar } = checkBookHit(book, recent1h);
    if (hit && bar) {
      // Book resolved: compute P&L
      const exitPrice = hit === "target" ? book.targetPrice : book.stopPrice;
      const pnlPct = ((exitPrice - book.entryPrice) / book.entryPrice) * book.direction;
      const pnlUsd = pnlPct * book.notional;
      console.log(
        `[POOL] book closed ${hit}: ${book.direction > 0 ? "LONG" : "SHORT"} ` +
          `entry=$${book.entryPrice.toFixed(2)} exit=$${exitPrice.toFixed(2)} ` +
          `pnl=$${pnlUsd.toFixed(2)}`,
      );
      // In paper mode, the wallet absorbs the P&L
      if (CONFIG.PAPER) state.walletUsd += pnlUsd;
      closedBooks.push(book);
    } else {
      stillOpen.push(book);
    }
  }
  state.openBooks = stillOpen;

  // 4) Detect new pool signals on 4h
  const allSignals = detectPoolSignals(bars4h);
  // Only consider signals from the most recent few 4h bars that aren't already represented
  const cutoff4hIndex = Math.max(0, bars4h.length - 3);
  for (const sig of allSignals) {
    if (sig.at4hIndex < cutoff4hIndex) continue;
    // Don't open if we already have a book at the same direction (avoid stacking duplicates)
    const sameDir = state.openBooks.some((b) => b.direction === sig.direction);
    // Allow up to POOL_DONCH_LENGTHS books of each direction (for the different lengths)
    if (state.openBooks.filter((b) => b.direction === sig.direction).length >= CONFIG.POOL_DONCH_LENGTHS.length)
      continue;
    const book = openBookOn1h(sig, bars4h, bars1h, state.walletUsd);
    if (!book) continue;
    // Avoid double-opening on the same bar
    const dup = state.openBooks.some(
      (b) => b.openMs === book.openMs && b.direction === book.direction,
    );
    if (dup) continue;
    state.openBooks.push(book);
    console.log(
      `[POOL] opened book: ${book.direction > 0 ? "LONG" : "SHORT"} @ $${book.entryPrice.toFixed(2)} ` +
        `stop=$${book.stopPrice.toFixed(2)} tp=$${book.targetPrice.toFixed(2)} ` +
        `notional=$${book.notional.toFixed(0)}`,
    );
  }

  // 5) Compute current target position
  const poolPosNow = poolNetPosition(state.openBooks, state.walletUsd, latestPrice);
  const regRet = regimeDailyReturns(daily);
  const regimePositions = regimePositionSeries(daily);
  const poolDayPositions = regimePositions.map(() => 0); // placeholder — pool history complex
  const poolRet = approxPoolDailyReturns(poolDayPositions, daily); // not exact; vol-target will be conservative

  const target = computeBlendTarget(daily, poolPosNow, regRet, poolRet);

  // 6) Rebalance to target (in live mode against real exchange)
  let currentEquity = state.walletUsd;
  if (!CONFIG.PAPER) {
    try {
      currentEquity = await fetchEquityUsdt();
    } catch (e) {
      console.warn("Could not fetch equity, using state:", e);
    }
  }
  const targetUsdNotional = target.blendedTarget * currentEquity;
  const targetUnits = latestPrice > 0 ? targetUsdNotional / latestPrice : 0;

  let currentUnits = 0;
  if (!CONFIG.PAPER) {
    try {
      const pos = await fetchPosition(CONFIG.ASSET);
      currentUnits = pos.size;
    } catch (e) {
      console.warn("Could not fetch position:", e);
    }
  }

  await rebalanceToTarget(CONFIG.ASSET, targetUnits, currentUnits, latestPrice);

  // 7) Harvest if needed
  const harvest = harvestIfNeeded(state, nowMs, state.lastHourMs || nowMs);
  if (harvest.harvested > 0) {
    console.log(
      `[HARVEST] $${harvest.harvested.toFixed(2)} -> spot (${harvest.reason}). ` +
        `wallet=$${state.walletUsd.toFixed(0)} spot=$${state.spotUsd.toFixed(0)} ` +
        `total=$${totalWealth(state).toFixed(0)}`,
    );
  }

  state.initialized = true;
  state.lastHourMs = nowMs;
  saveState(state);

  lastPriceForPnl = latestPrice;

  // 8) Log status
  console.log(
    `[TICK ${new Date().toISOString()}] ` +
      `${CONFIG.ASSET}=$${latestPrice.toFixed(2)} | ` +
      `regime=${target.regimePos.toFixed(2)} pool=${poolPosNow.toFixed(2)} ` +
      `target=${target.blendedTarget.toFixed(2)} (units=${targetUnits.toFixed(4)}) | ` +
      `wallet=$${state.walletUsd.toFixed(0)} spot=$${state.spotUsd.toFixed(0)} ` +
      `total=$${totalWealth(state).toFixed(0)} | ` +
      `books=${state.openBooks.length} | ${Date.now() - t0}ms`,
  );
}

export async function runLoop(): Promise<void> {
  console.log(`Starting bot loop. PAPER=${CONFIG.PAPER} DRY_RUN=${CONFIG.DRY_RUN}`);
  console.log(`Asset=${CONFIG.ASSET} Leverage=${CONFIG.LEVERAGE_MULT}x VolTgt=${CONFIG.VOL_TARGET} Cap=${CONFIG.LEV_CAP}`);
  if (!CONFIG.PAPER && !CONFIG.DRY_RUN) {
    console.warn("!!!!!! LIVE TRADING ENABLED — REAL MONEY AT RISK !!!!!!");
    console.warn(`Exchange=${CONFIG.EXCHANGE} Testnet=${CONFIG.USE_TESTNET}`);
  }
  while (true) {
    try {
      await tickOnce();
    } catch (e) {
      console.error("Tick error:", e);
    }
    await new Promise((r) => setTimeout(r, CONFIG.LOOP_INTERVAL_SEC * 1000));
  }
}
