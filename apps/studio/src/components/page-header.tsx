import type { ReactNode } from "react";

/** A page's title, what it is about, and its actions. The one shape every page opens with. */
export const PageHeader = ({
  title,
  description,
  actions,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
}) => (
  <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
    <div className="min-w-0">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description === undefined ? null : (
        <div className="mt-1 text-sm text-muted-foreground">{description}</div>
      )}
    </div>
    {actions === undefined ? null : <div className="flex shrink-0 gap-2">{actions}</div>}
  </div>
);
