import type { ReactNode } from "react";

/**
 * Heading for a master-data page.
 *
 * `aside` carries a figure that is genuinely known — a count, a payroll total —
 * never a placeholder. A statistic tile that is waiting for a module belongs on
 * the dashboard, where it can say so; here it would just be noise beside a list
 * that already shows the same records.
 */
export function MasterDataHeader({
  title,
  description,
  aside,
}: {
  title: string;
  description: string;
  aside?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      {aside}
    </header>
  );
}
