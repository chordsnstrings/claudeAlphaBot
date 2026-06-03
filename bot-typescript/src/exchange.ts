// exchange.ts — minimal ccxt wrapper for futures: fetch OHLCV, fetch balance, submit orders.
// Defaults to PAPER mode unless explicitly opted out.

import ccxt from "ccxt";
import { Bar, Timeframe } from "./types";
import { CONFIG, symbolFor } from "./config";

let exchange: any = null;

function getExchange(): any {
  if (exchange) return exchange;
  const exClass = (ccxt as any)[CONFIG.EXCHANGE];
  if (!exClass) throw new Error(`Unknown exchange: ${CONFIG.EXCHANGE}`);
  exchange = new exClass({
    apiKey: CONFIG.API_KEY || undefined,
    secret: CONFIG.API_SECRET || undefined,
    enableRateLimit: true,
    options: { defaultType: "future" },
  });
  if (CONFIG.USE_TESTNET && typeof exchange.setSandboxMode === "function") {
    try {
      exchange.setSandboxMode(true);
    } catch (e) {
      console.warn("Could not enable testnet:", e);
    }
  }
  return exchange;
}

/** Fetch the most recent N OHLCV bars at the given timeframe. */
export async function fetchBars(asset: string, tf: Timeframe, limit: number = 500): Promise<Bar[]> {
  const ex = getExchange();
  const symbol = symbolFor(asset);
  const raw = await ex.fetchOHLCV(symbol, tf, undefined, limit);
  return raw.map((row: number[]) => ({
    openMs: row[0],
    open: row[1],
    high: row[2],
    low: row[3],
    close: row[4],
    volume: row[5],
  }));
}

/** Fetch account total equity in USDT (futures wallet). */
export async function fetchEquityUsdt(): Promise<number> {
  if (CONFIG.PAPER) return CONFIG.BASE_USD;
  const ex = getExchange();
  const bal = await ex.fetchBalance();
  const usdt = bal?.total?.USDT ?? bal?.USDT?.total ?? 0;
  return Number(usdt) || 0;
}

/** Fetch current position size for the asset (signed, in base units). */
export async function fetchPosition(asset: string): Promise<{ size: number; entryPrice: number }> {
  if (CONFIG.PAPER) return { size: 0, entryPrice: 0 };
  const ex = getExchange();
  const symbol = symbolFor(asset);
  const positions = await ex.fetchPositions([symbol]);
  for (const p of positions) {
    if (p.symbol === symbol || p.info?.symbol === symbol.replace("/", "").replace(":USDT", "")) {
      const size = Number(p.contracts ?? p.contractSize ?? 0) * (p.side === "short" ? -1 : 1);
      const entryPrice = Number(p.entryPrice ?? p.info?.entryPrice ?? 0);
      return { size, entryPrice };
    }
  }
  return { size: 0, entryPrice: 0 };
}

/** Place a market order to reach the target position (in base asset units). */
export async function rebalanceToTarget(
  asset: string,
  targetUnits: number,
  currentUnits: number,
  refPrice: number,
): Promise<{ side: "buy" | "sell" | "none"; amount: number; cost: number; dry: boolean }> {
  const diff = targetUnits - currentUnits;
  if (Math.abs(diff * refPrice) < CONFIG.REBAL_BAND * CONFIG.BASE_USD) {
    return { side: "none", amount: 0, cost: 0, dry: false };
  }
  const side: "buy" | "sell" = diff > 0 ? "buy" : "sell";
  const amount = Math.abs(diff);
  const cost = amount * refPrice;
  if (CONFIG.PAPER || CONFIG.DRY_RUN) {
    console.log(
      `[${CONFIG.PAPER ? "PAPER" : "DRY"}] would ${side} ${amount.toFixed(4)} ${asset} (~$${cost.toFixed(0)})`,
    );
    return { side, amount, cost, dry: true };
  }
  const ex = getExchange();
  const symbol = symbolFor(asset);
  // Set leverage first (idempotent)
  try {
    await ex.setLeverage(CONFIG.MAX_LEV_EXCHANGE, symbol);
  } catch (e) {
    // some exchanges don't need this or it's already set
  }
  await ex.createMarketOrder(symbol, side, amount);
  console.log(`[LIVE] sent ${side} ${amount.toFixed(4)} ${asset} (~$${cost.toFixed(0)})`);
  return { side, amount, cost, dry: false };
}

/** Set a stop-loss order on the exchange (server-side stop). */
export async function setStopOrder(
  asset: string,
  side: "buy" | "sell",
  amount: number,
  stopPrice: number,
): Promise<void> {
  if (CONFIG.PAPER || CONFIG.DRY_RUN) {
    console.log(`[${CONFIG.PAPER ? "PAPER" : "DRY"}] would set stop ${side} ${amount} @ ${stopPrice}`);
    return;
  }
  const ex = getExchange();
  const symbol = symbolFor(asset);
  await ex.createOrder(symbol, "STOP_MARKET", side, amount, undefined, {
    stopPrice,
    reduceOnly: true,
  });
}
