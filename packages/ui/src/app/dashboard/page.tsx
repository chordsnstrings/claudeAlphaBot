import { PageTitle } from "@/components/page-title";
import { Card } from "@/components/card";

/** Dashboard — built out in Phase 16. Stub for Phase 15 rubric. */
export default function DashboardPage() {
  return (
    <div className="px-6 py-4 md:px-8 md:py-6">
      <PageTitle title="Dashboard" subtitle="Overview of bot state, positions, and performance." />
      <Card>
        <p className="text-default text-text-secondary">
          Dashboard content is populated in Phase 16.
        </p>
      </Card>
    </div>
  );
}
