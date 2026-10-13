import type { ReactNode } from 'react';

/** Title block shared by the secondary pages (Cohorts, Learning), so they read as one product. */
export function PageHeader({
  title,
  description,
  right,
}: {
  title: string;
  description?: ReactNode;
  right?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-surface-border pb-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">{title}</h1>
        {description && <div className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-400">{description}</div>}
      </div>
      {right}
    </div>
  );
}
