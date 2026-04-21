import Link from "next/link";

import { cn } from "@/lib/cn";
import { signColor } from "@/lib/format";
import { Card } from "./card";

export interface KpiCardProps {
  readonly label: string;
  readonly value: string;
  readonly delta?: string;
  readonly deltaNumeric?: number;
  readonly subtext?: string;
  readonly href?: string;
  /** 0-indexed position in the row; drives stagger animation. */
  readonly index?: number;
}

export function KpiCard({
  label,
  value,
  delta,
  deltaNumeric,
  subtext,
  href,
  index = 0,
}: KpiCardProps) {
  const stagger = `${index * 30}ms`;
  const inner = (
    <Card
      padding="lg"
      className="animate-fade-up h-full transition-colors duration-150 hover:bg-bg-2"
    >
      <div
        // Apply the stagger on the parent so the whole card enters together.
        style={{ animationDelay: stagger }}
      >
        <div className="text-secondary text-text-tertiary mb-2">{label}</div>
        <div className="font-mono text-kpi font-medium text-text-primary tabular-nums">
          {value}
        </div>
        {delta ? (
          <div
            className={cn(
              "mt-2 font-mono text-secondary",
              deltaNumeric !== undefined ? signColor(deltaNumeric) : "text-text-secondary",
            )}
          >
            {delta}
            {subtext ? (
              <span className="ml-2 text-text-tertiary">{subtext}</span>
            ) : null}
          </div>
        ) : subtext ? (
          <div className="mt-2 text-secondary text-text-tertiary">{subtext}</div>
        ) : null}
      </div>
    </Card>
  );
  return href ? (
    <Link href={href} className="block">
      {inner}
    </Link>
  ) : (
    inner
  );
}
