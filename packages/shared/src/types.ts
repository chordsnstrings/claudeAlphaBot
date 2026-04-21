import type {
  BotMode,
  CircuitBreakerKind,
  Direction,
  DriftOutcome,
  ExitReason,
  PortfolioOutcome,
  Regime,
  RevalTrigger,
  StrategyName,
  Symbol as TradingSymbol,
} from "./constants.js";

/**
 * A 1-hour OHLCV kline from Binance Futures.
 * All prices in USD(T). Timestamps are epoch milliseconds (UTC).
 */
export interface Candle {
  readonly symbol: TradingSymbol;
  readonly openTime: number;
  readonly closeTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/**
 * Funding rate published every 8 hours on Binance Futures.
 * Rate is expressed as a decimal (0.0001 = 0.01%).
 */
export interface FundingRate {
  readonly symbol: TradingSymbol;
  readonly fundingTime: number;
  readonly fundingRate: number;
}

/**
 * The intent to enter a trade, produced by a strategy module.
 * Does not yet include position size — sizing is applied by the risk module.
 */
export interface SignalIntent {
  readonly strategy: StrategyName;
  readonly symbol: TradingSymbol;
  readonly direction: Direction;
  readonly generatedAt: number;
  readonly entryPrice: number;
  readonly stopPrice: number;
  readonly tp1Price: number;
  readonly tp2Price: number;
  readonly tp1AllocationPct: number;
  readonly breakevenTriggerPrice: number;
  readonly timeStopUtc: number;
  readonly reasoning: string;
  readonly meta?: Readonly<Record<string, number | string | boolean>>;
}

/**
 * A signal that has passed pre-trade checks and been sized.
 */
export interface SizedSignal extends SignalIntent {
  readonly quantity: number;
  readonly notionalUsd: number;
  readonly riskUsd: number;
  readonly marginUsd: number;
  readonly leverage: number;
}

/**
 * A live or simulated open position.
 */
export interface OpenPosition {
  readonly id: string;
  readonly mode: BotMode;
  readonly strategy: StrategyName;
  readonly symbol: TradingSymbol;
  readonly direction: Direction;
  readonly entryTime: number;
  readonly entryPrice: number;
  readonly quantity: number;
  readonly remainingQuantity: number;
  readonly notionalUsd: number;
  readonly stopPrice: number;
  readonly tp1Price: number;
  readonly tp2Price: number;
  readonly breakevenTriggerPrice: number;
  readonly timeStopUtc: number;
  readonly tp1Filled: boolean;
  readonly breakevenMoved: boolean;
  readonly feesPaidUsd: number;
  readonly realizedPnlUsd: number;
  readonly exchangeOrderIds?: readonly string[];
}

/**
 * A completed trade journal row. Matches spec §8.5 exactly.
 */
export interface Trade {
  readonly tradeId: number;
  readonly mode: BotMode;
  readonly strategy: StrategyName;
  readonly symbol: TradingSymbol;
  readonly direction: Direction;
  readonly entryTime: number;
  readonly entryPrice: number;
  readonly quantity: number;
  readonly notionalUsd: number;
  readonly stopPrice: number;
  readonly tp1Price: number;
  readonly tp2Price: number;
  readonly exitTime: number;
  readonly exitPrice: number;
  readonly exitReason: ExitReason;
  readonly pnlUsd: number;
  readonly pnlR: number;
  readonly feesPaid: number;
  readonly accountEquityBefore: number;
  readonly accountEquityAfter: number;
}

export interface AccountState {
  equity: number;
  startingEquity: number;
  dailyPnlByUtcDate: Map<string, number>;
  weeklyPnlByIsoWeek: Map<string, number>;
  consecutiveLossesBySymbol: Map<TradingSymbol, number>;
  cooldownUntilBySymbol: Map<TradingSymbol, number>;
  openPositions: OpenPosition[];
  halted: boolean;
}

/**
 * Snapshot fields captured at validation time per spec §8.12.1.
 */
export interface SymbolSnapshot {
  readonly symbol: TradingSymbol;
  readonly regime: Regime;
  readonly confidence: number;
  readonly bbWidthPercentile: number;
  readonly ema99Slope: number;
  readonly atrPct: number;
}

export interface ValidationSnapshot {
  readonly artifactHash: string;
  readonly createdAtUtc: number;
  readonly perSymbol: readonly SymbolSnapshot[];
  readonly btcRealizedVol30d: number;
  readonly notes?: string;
}

/**
 * The winning parameter set, matching spec §8.11.2.
 * Values are kept as a flat record — every field is serializable to JSON.
 */
export type WinningParameters = Readonly<Record<string, number | boolean | string>>;

export interface BacktestSummary {
  readonly totalReturnPct: number;
  readonly sharpe: number;
  readonly maxDdPct: number;
  readonly tradeCount: number;
  readonly winRatePct: number;
  readonly profitFactor: number;
}

export interface MonteCarloSummary {
  readonly runs: number;
  readonly medianReturnPct: number;
  readonly p5ReturnPct: number;
  readonly p95ReturnPct: number;
  readonly p95MaxDdPct: number;
  readonly probNegativeReturnPct: number;
}

export interface WalkForwardSummary {
  readonly windowsTested: number;
  readonly avgTestSharpe: number;
  readonly trainToTestRatio: number;
  readonly paramStabilityMaxDeviationPct: number;
}

export interface OutOfSampleSummary {
  readonly period: string;
  readonly sharpe: number;
  readonly maxDdPct: number;
  readonly returnPct: number;
}

/**
 * The validated_config.json artifact — spec §8.11.2.
 */
export interface ValidatedConfig {
  readonly artifactVersion: "1.0";
  readonly createdAt: string;
  readonly codeHash: string;
  readonly dataWindow: {
    readonly start: string;
    readonly end: string;
    readonly monthsCovered: number;
  };
  readonly symbols: readonly TradingSymbol[];
  readonly winningParameters: WinningParameters;
  readonly validationResults: {
    readonly backtest: BacktestSummary;
    readonly monteCarlo: MonteCarloSummary;
    readonly walkForward: WalkForwardSummary;
    readonly outOfSample: OutOfSampleSummary;
  };
  readonly compositeScore: number;
  readonly deploymentAllowed: boolean;
  readonly deploymentBlockers?: readonly string[];
}

export interface RegimeCheckRow {
  readonly id: number;
  readonly timestampUtc: number;
  readonly symbol: TradingSymbol;
  readonly outcome: DriftOutcome;
  readonly currentRegime: Regime;
  readonly validationRegime: Regime;
  readonly confidenceCurrent: number;
  readonly confidenceAtValidation: number;
  readonly confidenceDeltaPct: number;
  readonly bbWidthPctCurrent: number;
  readonly bbWidthPctAtValidation: number;
  readonly bbWidthDeltaPoints: number;
  readonly ema99SlopeCurrent: number;
  readonly ema99SlopeAtValidation: number;
  readonly consecutiveDaysSameOutcome: number;
}

export interface RevalidationEvent {
  readonly id: number;
  readonly triggerReason: RevalTrigger;
  readonly startedAtUtc: number;
  readonly completedAtUtc: number | null;
  readonly durationSeconds: number | null;
  readonly previousArtifactHash: string | null;
  readonly newArtifactHash: string | null;
  readonly meanParameterDeviationPct: number | null;
  readonly autoSwapApplied: boolean;
  readonly operatorApproved: boolean | null;
  readonly approvedAtUtc: number | null;
  readonly notes: string | null;
}

export interface CircuitBreakerEvent {
  readonly id: number;
  readonly timestampUtc: number;
  readonly kind: CircuitBreakerKind;
  readonly symbol: TradingSymbol | null;
  readonly triggeredByPnlPct: number | null;
  readonly accountEquity: number;
  readonly action: string;
  readonly releasedAtUtc: number | null;
}

export interface PortfolioOutcomeRow {
  readonly outcome: PortfolioOutcome;
  readonly symbols: readonly { symbol: TradingSymbol; outcome: DriftOutcome }[];
  readonly evaluatedAtUtc: number;
}

/**
 * Bot status returned by GET /api/status.
 */
export interface BotStatus {
  readonly mode: BotMode;
  readonly uptime: number;
  readonly artifact: {
    readonly path: string;
    readonly codeHash: string | null;
    readonly createdAt: string | null;
    readonly deploymentAllowed: boolean;
  } | null;
  readonly openPositionCount: number;
  readonly lastRegimeCheckUtc: number | null;
  readonly halted: boolean;
}
