import { Card } from "@/components/card";

/**
 * Route-level loading fallback. Skeleton matches the general page
 * layout — title bar, then a 4-card KPI row, then a wider panel.
 * Always uses `animate-skeleton-pulse` which is opacity-only, so no
 * layout shift when content arrives.
 */
export default function Loading() {
  return (
    <div className="px-6 py-4 md:px-8 md:py-6">
      <div className="h-7 w-48 bg-bg-1 rounded-md animate-skeleton-pulse mb-6" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i}>
            <div className="h-3 w-16 bg-bg-2 rounded animate-skeleton-pulse mb-3" />
            <div className="h-7 w-24 bg-bg-2 rounded animate-skeleton-pulse" />
          </Card>
        ))}
      </div>
      <Card>
        <div className="h-64 bg-bg-2 rounded animate-skeleton-pulse" />
      </Card>
    </div>
  );
}
