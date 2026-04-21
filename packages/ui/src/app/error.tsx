"use client";

import { Card } from "@/components/card";

export default function GlobalError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  return (
    <div className="px-6 py-4 md:px-8 md:py-6">
      <Card>
        <h2 className="text-subhead font-semibold text-red mb-2">
          Something went wrong
        </h2>
        <p className="text-default text-text-secondary mb-4">
          {error.message || "Unexpected error rendering this page."}
        </p>
        {error.digest ? (
          <p className="text-secondary text-text-tertiary font-mono mb-4">
            digest: {error.digest}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-md bg-bg-2 hover:bg-bg-3 text-text-primary px-3 py-1.5 text-default transition-colors duration-150 active:scale-[0.98]"
        >
          Retry
        </button>
      </Card>
    </div>
  );
}
