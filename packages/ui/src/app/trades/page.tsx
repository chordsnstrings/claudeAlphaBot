import { Card } from "@/components/card";
import { FullTradesTable } from "@/components/full-trades-table";
import { PageShell } from "@/components/page-shell";
import { loadAllTrades } from "@/db/queries-ext";
import type { TradeRow } from "@/db/queries-ext";

export const revalidate = 30;

type Search = Record<string, string | string[] | undefined>;

function pickOne(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function TradesPage({
  searchParams,
}: {
  readonly searchParams?: Search;
}) {
  const symbol = pickOne(searchParams?.["symbol"]);
  const strategy = pickOne(searchParams?.["strategy"]);
  const direction = pickOne(searchParams?.["direction"]);

  const allRows = await loadAllTrades(500);
  const rows: readonly TradeRow[] = allRows.filter((r) => {
    if (symbol && symbol !== "ALL" && r.symbol !== symbol) return false;
    if (strategy && strategy !== "ALL" && r.strategy !== strategy) return false;
    if (direction && direction !== "ALL" && r.direction !== direction) return false;
    return true;
  });

  return (
    <PageShell
      title="Trade History"
      subtitle="All recorded trades with filters. Newest first, capped at 500 rows."
    >
      <Card padding="md" className="mb-4 animate-fade-up">
        <FilterBar
          {...(symbol !== undefined ? { symbol } : {})}
          {...(strategy !== undefined ? { strategy } : {})}
          {...(direction !== undefined ? { direction } : {})}
        />
      </Card>
      <Card padding="md" className="animate-fade-up">
        <div className="flex items-center justify-between mb-3 px-3">
          <div className="text-subhead font-medium text-text-primary">
            {rows.length} trades
          </div>
          <span className="text-secondary text-text-tertiary font-mono">
            of {allRows.length}
          </span>
        </div>
        <FullTradesTable rows={rows} />
      </Card>
    </PageShell>
  );
}

function FilterBar({
  symbol,
  strategy,
  direction,
}: {
  readonly symbol?: string;
  readonly strategy?: string;
  readonly direction?: string;
}) {
  return (
    <form
      method="GET"
      className="flex flex-wrap items-end gap-3 px-3"
      aria-label="Filter trades"
    >
      <FilterSelect
        name="symbol"
        {...(symbol !== undefined ? { value: symbol } : {})}
        label="Symbol"
        options={["ALL", "BTCUSDT", "ETHUSDT", "SOLUSDT"]}
      />
      <FilterSelect
        name="strategy"
        {...(strategy !== undefined ? { value: strategy } : {})}
        label="Strategy"
        options={["ALL", "ARB", "NY_OPEN", "WEEKEND_MR", "FUNDING_FADE", "BB_MR"]}
      />
      <FilterSelect
        name="direction"
        {...(direction !== undefined ? { value: direction } : {})}
        label="Direction"
        options={["ALL", "LONG", "SHORT"]}
      />
      <button
        type="submit"
        className="bg-accent text-bg-0 font-medium rounded-md px-3 py-1.5 hover:bg-accent-hover transition-colors duration-150"
      >
        Apply
      </button>
      <a
        href="/trades"
        className="text-secondary text-text-tertiary hover:text-text-primary transition-colors duration-150"
      >
        Reset
      </a>
    </form>
  );
}

function FilterSelect({
  name,
  value,
  label,
  options,
}: {
  readonly name: string;
  readonly value?: string;
  readonly label: string;
  readonly options: readonly string[];
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-secondary text-text-tertiary">{label}</span>
      <select
        name={name}
        defaultValue={value ?? "ALL"}
        className="bg-bg-2 border border-border-default rounded-md px-2 py-1 font-mono text-default text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
