import { Card } from "@/components/card";
import { PageShell } from "@/components/page-shell";
import { PositionsTable } from "@/components/positions-table";
import { loadOpenPositions } from "@/db/queries";

export const revalidate = 15;

export default async function PositionsPage() {
  const positions = await loadOpenPositions();
  return (
    <PageShell
      title="Open Positions"
      subtitle="Currently-open positions with stop / TP levels."
    >
      <Card padding="md" className="animate-fade-up">
        <div className="flex items-center justify-between mb-3 px-3">
          <div className="text-subhead font-medium text-text-primary">
            {positions.length} open
          </div>
        </div>
        <PositionsTable rows={positions} />
      </Card>
    </PageShell>
  );
}
