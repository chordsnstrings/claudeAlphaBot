# Architecture

High-level design + key decisions. Source of truth for "why is this
structured this way" questions.

## Two modes, one engine

The system runs in **backtest** or **live** mode. Mode selection
happens once at the composition root and the engine itself is
strictly mode-agnostic: every `if mode === 'live'` branch lives in
`packages/adapters/build-{backtest,live}.ts` and nowhere else.

```
                 ┌─────────────────────────────┐
                 │     TradingSystem.run()     │  (mode-invariant)
                 │                             │
                 │  for await (bar of feed):   │
                 │    clock.advanceTo(bar.ts)  │
                 │    exec.processBar(bar)     │
                 │    indicators = compute(…)  │
                 │    state = build(…)         │
                 │    for s in strategies:     │
                 │      sigs = s.generate(…)   │
                 │    orders = orch.process(…) │
                 │    for o in orders:         │
                 │      if risk.canExecute(…)  │
                 │        exec.submitOrder(o)  │
                 │      audit.recordSignal(…)  │
                 │    metrics.update(state)    │
                 └────────────┬────────────────┘
                              │
                              ▼ MarketDataFeed | ExecutionAdapter | Clock
        ┌──────────────────────────────────────────────────────────┐
        │                                                          │
        ▼ Backtest                                              ▼ Live
  HistoricalDataFeed   ─ TimescaleDB cursor                    CTraderDataFeed   ─ wss://demo.ctraderapi.com:5036
  SimulatedExecution   ─ FrictionModel + in-mem book           CTraderExecution  ─ ProtoOA* messages
  SimulatedClock       ─ advanced by engine on each bar        SystemClock       ─ Date.now()
```

## Package dependency graph

```
       core ─────────────────────────────────────────────────────────┐
        │                                                            │
        │              ┌─ engine ──── adapters ──── cli              │
        ├─ data        │                                             │
        │   │          │                                             │
        │   └─ ingestion (Dukascopy)                                 │
        │                                                            │
        ├─ metrics ──── adapters                                     │
        ├─ risk ─────── adapters ─ cli                               │
        ├─ strategies ─ cli                                          │
        └─ orchestrator                                              │
                                                              web ───┘
```

No cycles. `core` has zero internal dependencies; everything else
depends on it.

## Why no DI container

The boundary interfaces (`MarketDataFeed`, `ExecutionAdapter`,
`Clock`, `Strategy`, `RiskManager`, `Orchestrator`,
`MetricsCollector`, `AuditLog`) are sufficient as a poor-man's DI.
`buildBacktestDeps(config)` and `buildLiveDeps(config)` are the only
two functions that wire concrete implementations. The engine class
takes a `TradingSystemDeps` bag.

Tests inject their own concrete or stub deps directly. Adding a
container library would buy nothing for the ~50 wiring sites this
system actually has.

## Determinism guarantees

- All RNG goes through `mulberry32` in `@trading/core/utils/random`.
  Seeds are 32-bit derived from `session.randomSeed` (bigint) via
  `seedFromBigint`.
- `MetricsCollector` re-uses the seed for the bootstrap Sharpe CI
  and Monte Carlo trade reshuffle so a backtest with the same seed
  produces identical statistical bundles.
- `FrictionModel` re-uses the seed for spread / slippage / news
  amplification — identical fills bar-for-bar.

## TimescaleDB

`bar`, `signal_log`, and `trade` are TimescaleDB hypertables when
the extension is installed. Migration `0001_init_extensions.sql`
attempts `CREATE EXTENSION IF NOT EXISTS timescaledb` inside a `DO
$$ EXCEPTION` block — if the extension isn't installed, the tables
stay as plain Postgres relations and the rest of the system works
correctly. Production must install TimescaleDB so the 1-month chunk
intervals + automatic compression kick in.

## No-lookahead enforcement

Three layers:

1. `HistoricalDataFeed.subscribe()` yields bars in chronological
   order from the DB cursor; multi-instrument streams are
   server-side merged by `(timestamp_utc, instrument, timeframe)`.
2. The iterator gates on `bar.ts <= clock.now() + period(tf)` —
   "one bar of slack" so the engine can pull the next bar before
   advancing the clock (avoids deadlock).
3. `TradingSystem.processBar(bar)` calls
   `clock.advanceTo?.(bar.timestampUtc)` BEFORE computing
   indicators, building MarketState, or calling strategies. Tests
   confirm `state.now === state.currentBar.timestampUtc` on every
   strategy call.

## Friction model determinism

`FrictionModel` (spec §6) holds a single seeded RNG per session.
Spread / slippage / news-amplification all draw from it in a fixed
order:

```
on each fill:
  rng.nextNormal(...)   ← spread Gaussian sample
  rng.nextRange(0, 5)   ← news amplifier (only if isInNewsWindow)
  rng.nextRange(0, 10)  ← slippage news amplifier (only if news)
```

Two re-runs with the same seed produce byte-identical fills.

## RiskManager hot-reload

`@trading/risk/RuntimeOps.reloadRiskConfig(by, next)` persists the
new `RiskConfig` to `config_setting.risk.config` and calls
`deps.applyRiskConfig(next)` which mutates the running
`RiskManager`'s internal config. The next per-bar `canExecute(...)`
uses the new thresholds. No engine restart needed.

## Audit invariants

- Every signal lands in `signal_log` with either `becameTradeId` set
  (if it became a position) or `rejectedReason` set (if the risk
  gate rejected it). No signal is silently dropped.
- Every state transition (strategy pause/resume/kill, config
  change, emergency stop, broker connect/disconnect) lands in
  `audit_event` with a `severity` matching the operator
  expectation: `info` for routine, `warn` for risk gates,
  `error`/`fatal` for halts.
- The `previous_value` column of `config_setting` records the
  pre-change value so a config history is queryable directly from
  the DB without joining audit_event.
