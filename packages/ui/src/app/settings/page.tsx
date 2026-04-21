import { Card } from "@/components/card";
import { PageShell } from "@/components/page-shell";
import { loadKpis, loadStatus } from "@/db/queries";

export const revalidate = 60;

export default async function SettingsPage() {
  const startingEquityUsd = Number(process.env["STARTING_EQUITY_USD"] ?? 5000);
  const [kpis, status] = await Promise.all([loadKpis(startingEquityUsd), loadStatus()]);
  const rows: readonly (readonly [string, string])[] = [
    ["Mode", status.mode],
    ["Starting equity", `$${startingEquityUsd.toFixed(2)}`],
    ["Current equity", `$${kpis.equityUsd.toFixed(2)}`],
    ["Symbols", "BTCUSDT · ETHUSDT · SOLUSDT"],
    [
      "Strategies",
      "ARB · NY_OPEN · WEEKEND_MR · FUNDING_FADE · BB_MR",
    ],
    ["Regime cron", "30 0 * * * (daily 00:30 UTC)"],
    ["Revalidation cron", "0 2 */14 * * (every 14 days 02:00 UTC)"],
    ["Command rate-limit", "1 req / 10s per endpoint"],
    ["Last regime check", status.lastRegimeCheckIso ?? "never"],
    ["Dashboard revalidate", "30s"],
  ];

  return (
    <PageShell
      title="Settings"
      subtitle="Read-only view of runtime configuration. All values are sourced from the bot env + DB."
    >
      <Card padding="md" className="animate-fade-up">
        <dl className="divide-y divide-border-subtle">
          {rows.map(([label, value]) => (
            <div
              key={label}
              className="flex items-center justify-between py-2 px-3 gap-4"
            >
              <dt className="text-default text-text-secondary">{label}</dt>
              <dd className="text-default font-mono text-text-primary text-right break-all">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
      <p className="mt-4 text-secondary text-text-tertiary px-1">
        To change any of these, edit the bot's environment variables and restart. Settings are
        intentionally non-editable from the UI to keep config reproducible across environments.
      </p>
    </PageShell>
  );
}
