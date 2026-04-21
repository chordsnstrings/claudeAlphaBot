import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface CardProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly padding?: "sm" | "md" | "lg";
}

export function Card({ children, className, padding = "md" }: CardProps) {
  const pad = padding === "sm" ? "p-4" : padding === "lg" ? "p-6" : "p-4";
  return (
    <div className={cn("bg-bg-1 rounded-lg border border-border-subtle", pad, className)}>
      {children}
    </div>
  );
}
