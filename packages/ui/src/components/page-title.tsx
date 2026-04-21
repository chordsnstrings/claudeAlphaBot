export interface PageTitleProps {
  readonly title: string;
  readonly subtitle?: string;
}

export function PageTitle({ title, subtitle }: PageTitleProps) {
  return (
    <div className="mb-6">
      <h1 className="text-page-title font-semibold text-text-primary">{title}</h1>
      {subtitle ? (
        <p className="text-default text-text-tertiary mt-1">{subtitle}</p>
      ) : null}
    </div>
  );
}
