# ETH Blend Bot — Replit Deployment

Production TypeScript implementation of the v1 ETH combined blend (regime engine + breakout pool, 25/75 weighted, vol-targeted to 30%, harvest-to-cash at 15% decay) — validated WF-OOS at +24%/yr Sharpe 0.80 on ETH 2020-2026.

## Quick Start on Replit

### 1. Create a new Repl
1. Go to https://replit.com → "Create Repl"
2. Choose "Node.js" template
3. Name it `eth-blend-bot`

### 2. Copy these files into the Repl
- `package.json`, `tsconfig.json`, `.replit`, `.env.example`
- All files in `src/`
- This `README.md`

### 3. Install dependencies
In the Replit Shell:
```bash
npm install
```

### 4. Configure environment
1. Copy `.env.example` to `.env`
2. Edit `.env` — at minimum, leave `PAPER=true` and `DRY_RUN=true` for first run
3. To go live later: see "Going Live" below

### 5. Run paper mode (NO real orders)
Click **Run** in Replit, or in shell:
```bash
npm run paper
```

You should see output like:
```
Starting bot loop. PAPER=true DRY_RUN=true
Asset=ETH Leverage=1x VolTgt=0.3 Cap=1.5
[TICK 2026-06-03T...] ETH=$1849.00 | regime=-0.70 pool=-1.48 target=-1.28 (units=-6.95) | wallet=$10000 spot=$0 total=$10000 | books=0 | 1240ms
```

The bot is now paper-trading. It checks the market every 5 minutes (`LOOP_INTERVAL_SEC=300`).

### 6. Run a single tick to verify
```bash
npx tsx src/index.ts --once
```

## File Structure
```
.
├── .env.example        # configuration template
├── .replit             # Replit run config
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts        # entrypoint
    ├── bot.ts          # main loop + tick logic
    ├── config.ts       # configuration from env
    ├── types.ts        # shared types
    ├── indicators.ts   # SMA, EMA, ATR, ADX, Donchian
    ├── regime.ts       # parameter-light regime committee (32 rules)
    ├── pool.ts         # breakout pool: concurrent 4h Donchian books
    ├── blend.ts        # 25/75 blend + vol-targeting
    ├── harvest.ts      # 15%-decay + year-end harvest to "spot"
    ├── state.ts        # persists state to .bot-state.json
    └── exchange.ts     # ccxt wrapper for Binance USDM
```

## Strategy Summary

| component | what it does |
|---|---|
| **Regime sleeve** (25%) | Parameter-light committee of 32 trend rules. Long in bull regimes, short on weakness in bear. Hedges crashes. |
| **Breakout pool** (75%) | Up to 3 concurrent 4h Donchian-breakout books (lengths 20/50/100), trend+ADX filtered. Hard ATR×2 stops, 2:1 RR. The workhorse. |
| **Vol-targeting** | Each sleeve scaled to 30% annual vol (causal trailing), capped at 1.5x leverage. |
| **Harvest** | When trading wallet drops 15% from a high, the excess above base ($10,000) is moved to a "spot" wallet (banked, not at risk). Annual sweep at year-end. |

## WF-OOS Validated Performance (2020-2026)
- Weight-WF: **+24%/yr, Sharpe 0.80, −28% DD**
- Fully nested WF: +20%/yr, Sharpe 0.68, −41% DD
- Last 7 days (Jun 2026 ETH crash): **+6.17% on $10k**

## Going Live (DO NOT SKIP STEPS)

1. **Stay in paper mode for at least 1 week.** Verify the bot's decisions look sensible.
2. **Get Binance Testnet API keys** at https://testnet.binancefuture.com — these are free fake-money keys.
3. Set in `.env`:
   ```
   PAPER=false
   DRY_RUN=true
   USE_TESTNET=true
   EXCHANGE_API_KEY=<testnet key>
   EXCHANGE_API_SECRET=<testnet secret>
   ```
4. Run for a few days, watch the logs.
5. When confident, set `DRY_RUN=false` (still testnet). Bot will place real testnet orders.
6. After successful testnet, switch to real Binance USDM keys + `USE_TESTNET=false` — start with a SMALL `BASE_USD` (e.g., $200).

## Critical Safety Notes

- **PAPER=true is the default.** No real orders are ever sent in paper mode.
- **DRY_RUN=true** is a secondary kill switch — prints orders without sending.
- **MAX_LEV_EXCHANGE=10** is the exchange leverage cap. The strategy's effective leverage stays well below this — verified in the WF-OOS intrabar liquidation analysis (no liquidations at 2× in 6 years; ruin threshold ~6×).
- **State persists** to `.bot-state.json`. Delete it to reset wallet/spot tracking.
- **Replit free tier sleeps.** For 24/7 operation, use a paid Replit deployment OR ping the Repl URL every few minutes from cron-job.org.

## Tweaking Risk

In `.env`:
- **Conservative**: `LEVERAGE_MULT=1.0` (default — about +24%/yr expected)
- **Aggressive**: `LEVERAGE_MULT=2.0` (about +38%/yr expected, −42% max DD)
- **High risk**: `LEVERAGE_MULT=3.0` (about +81%/yr, −71% max DD, close to ruin if mispriced)
- **DO NOT** set above 3.0 — the WF-OOS leverage analysis showed 3× is already past Kelly; 5× shows growth decay and 6×+ is liquidation territory.

## Logs and Monitoring

The bot prints a status line every tick:
```
[TICK <iso-time>] ETH=$<price> | regime=<pos> pool=<pos> target=<blend> (units=<units>) | wallet=$ spot=$ total=$ | books=<n> | <ms>
```

- `target` is the blended target as a fraction of equity (e.g., -1.28 means net short 1.28x equity)
- `books=N` is the number of currently-open pool bracket positions
- Harvest events are logged separately with `[HARVEST]`

## Troubleshooting

**"Not enough bars yet"**: Wait a few minutes — the bot is downloading history.

**"ccxt: rate limit"**: increase `LOOP_INTERVAL_SEC` to 600 (10 min).

**"Authentication failed"**: Recheck API keys. Make sure futures permissions are enabled, not just spot.

**Position seems too small/big**: Verify `BASE_USD` matches your actual margin balance. The bot sizes to `BASE_USD` regardless of actual balance — adjust this to match what you're actually allocating to the strategy.

## License / Disclaimer

This is research code converted to production for personal use. **Cryptocurrency trading carries substantial risk of loss. The author makes no warranties and assumes no liability for trading losses. Always start in paper/testnet mode. Past WF-OOS backtests do not guarantee future performance.**
