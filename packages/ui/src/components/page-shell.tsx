import type { ReactNode } from "react";

import { loadStatus } from "@/db/queries";
import { TopBar } from "./top-bar";
import { PageTitle } from "./page-title";

/**
 * Wraps every non-dashboard page in the standard TopBar + title band so
 * header data (mode, uptime, last regime check) is consistent site-wide.
 * Server component — loads status once on render, then streams children.
 */
export async function PageShell({
  title,
  subtitle,
  children,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
}) {
  const status = await loadStatus();
  const uptimeMs = Date.now() - status.bootTimeMs;
  return (
    <div className="min-h-screen">
      <TopBar
        mode={status.mode}
        uptimeMs={uptimeMs}
        lastRegimeCheckIso={status.lastRegimeCheckIso}
      />
      <div className="px-6 py-4 md:px-8 md:py-6">
        <PageTitle title={title} {...(subtitle !== undefined ? { subtitle } : {})} />
        {children}
      </div>
    </div>
  );
}
