import { Card } from "./card";
import { PageTitle } from "./page-title";

/** Phase 15 placeholder; Phase 17 fills in real content per page. */
export function StubPage({ title, subtitle }: { readonly title: string; readonly subtitle: string }) {
  return (
    <div className="px-6 py-4 md:px-8 md:py-6">
      <PageTitle title={title} subtitle={subtitle} />
      <Card>
        <p className="text-default text-text-secondary">
          Content for this page is built in Phase 17.
        </p>
      </Card>
    </div>
  );
}
