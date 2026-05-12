/** Account snapshot returned by ExecutionAdapter.getAccountInfo(). */

export interface AccountInfo {
  /** Broker account ID, or "backtest-{sessionId}" in backtest mode. */
  accountId: string;
  accountType: "demo" | "live" | "backtest";
  /** Account currency (always 'USD' for the configured Pepperstone account). */
  currency: string;
  equityUsd: number;
  balanceUsd: number;
  marginUsedUsd: number;
  marginFreeUsd: number;
  openPositionsCount: number;
  /** Sum across open positions, expressed as % of equity. */
  totalOpenRiskPct: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
}
