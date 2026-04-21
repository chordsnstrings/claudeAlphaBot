"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatUsd, formatUtc } from "@/lib/format";
import type { EquityPoint } from "@/db/queries";

export interface EquityChartProps {
  readonly data: readonly EquityPoint[];
}

/**
 * Recharts AreaChart with gradient fill from accent to transparent.
 * No grid, subtle x-axis tick labels only. Tooltip on hover shows
 * formatted equity + UTC timestamp. Height fills the container.
 */
export function EquityChart({ data }: EquityChartProps) {
  const series = useMemo(
    () =>
      data.map((p) => ({
        t: p.timestampUtc,
        equity: p.equityUsd,
      })),
    [data],
  );

  if (series.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-text-tertiary text-default">
        No equity history yet — data appears after the first trade.
      </div>
    );
  }

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="eq-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#FCD535" stopOpacity={0.25} />
              <stop offset="100%" stopColor="#FCD535" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="t"
            axisLine={false}
            tickLine={false}
            stroke="var(--text-tertiary)"
            fontSize={11}
            tickFormatter={(ms) => formatUtc(Number(ms)).slice(5, 10)}
            minTickGap={40}
          />
          <YAxis
            dataKey="equity"
            axisLine={false}
            tickLine={false}
            stroke="var(--text-tertiary)"
            fontSize={11}
            width={60}
            tickFormatter={(v) => `$${Math.round(Number(v)).toLocaleString()}`}
          />
          <Tooltip
            cursor={{ stroke: "var(--border-default)", strokeWidth: 1 }}
            contentStyle={{
              background: "var(--bg-1)",
              border: "1px solid var(--border-default)",
              borderRadius: "6px",
              fontFamily: "JetBrains Mono, ui-monospace, monospace",
            }}
            labelFormatter={(ms: number | string) => formatUtc(Number(ms)) + " UTC"}
            formatter={(v: number | string) => [formatUsd(Number(v)), "equity"]}
          />
          <Area
            type="monotone"
            dataKey="equity"
            stroke="#FCD535"
            strokeWidth={1.5}
            fill="url(#eq-gradient)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
