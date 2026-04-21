import Link from "next/link";

import { Card } from "@/components/card";

export default function NotFound() {
  return (
    <div className="px-6 py-4 md:px-8 md:py-6">
      <Card>
        <h2 className="text-subhead font-semibold text-text-primary mb-2">Page not found</h2>
        <p className="text-default text-text-secondary mb-4">
          The page you requested does not exist.
        </p>
        <Link
          href="/dashboard"
          className="text-default text-accent hover:text-accent-hover transition-colors duration-150"
        >
          → Back to Dashboard
        </Link>
      </Card>
    </div>
  );
}
