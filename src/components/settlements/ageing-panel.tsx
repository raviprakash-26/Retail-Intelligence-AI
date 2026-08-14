import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/format";
import { AGEING_BUCKETS } from "@/lib/settlements/ageing";
import type { LedgerAgeing } from "@/server/settlements/outstanding";

/**
 * Who owes what, and for how long.
 *
 * Buckets are counted from the due date, not the document date — an invoice on
 * 30 days' credit raised three weeks ago is not overdue, and a report that says
 * it is sends someone to chase a customer who has done nothing wrong.
 *
 * Every figure here is total minus settled, read from the documents themselves.
 * Nothing is a stored running balance, so nothing can drift away from the
 * invoices it claims to summarise.
 */
export function AgeingPanel({
  ageing,
  title,
  emptyNote,
  partyNoun,
}: {
  ageing: LedgerAgeing;
  title: string;
  emptyNote: string;
  partyNoun: string;
}) {
  const total = Number(ageing.summary.total);

  if (total <= 0) {
    return (
      <div className="mb-6 rounded-xl border border-dashed px-5 py-6 text-center">
        <p className="text-sm text-muted-foreground">{emptyNote}</p>
      </div>
    );
  }

  const overdue = Number(ageing.summary.overdue);

  return (
    <div className="mb-6 rounded-xl border px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Counted from each document&rsquo;s due date.
          </p>
        </div>
        <div className="text-right">
          <p className="tabular-figures text-xl font-semibold">
            {formatCurrency(ageing.summary.total, {
              compactZeroDecimals: true,
            })}
          </p>
          {overdue > 0 && (
            <p className="flex items-center justify-end gap-1 text-xs text-destructive">
              <AlertTriangle className="size-3" />
              {formatCurrency(overdue, { compactZeroDecimals: true })} overdue
              {ageing.summary.oldestOverdueDays
                ? `, oldest ${ageing.summary.oldestOverdueDays}d`
                : ""}
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-5">
        {AGEING_BUCKETS.map((bucket) => {
          const amount = Number(ageing.summary.buckets[bucket.key] ?? 0);
          return (
            <div
              key={bucket.key}
              className="rounded-lg border px-3 py-2"
              data-empty={amount === 0}
            >
              <p className="text-[0.6875rem] text-muted-foreground">
                {bucket.label}
              </p>
              <p
                className={
                  amount > 0 && bucket.key !== "current"
                    ? "tabular-figures text-sm font-medium text-destructive"
                    : "tabular-figures text-sm font-medium"
                }
              >
                {amount === 0
                  ? "—"
                  : formatCurrency(amount, { compactZeroDecimals: true })}
              </p>
            </div>
          );
        })}
      </div>

      {ageing.parties.length > 0 && (
        <ul className="mt-4 space-y-1.5 border-t pt-3">
          {ageing.parties.slice(0, 5).map((party) => (
            <li
              key={party.id}
              className="flex flex-wrap items-center justify-between gap-2 text-sm"
            >
              <span className="flex items-center gap-2">
                {party.name}
                {party.oldestOverdueDays !== null && (
                  <Badge
                    variant={
                      party.oldestOverdueDays > 60 ? "danger" : "warning"
                    }
                    className="text-[0.625rem]"
                  >
                    {party.oldestOverdueDays}d overdue
                  </Badge>
                )}
              </span>
              <span className="tabular-figures">
                {formatCurrency(party.outstanding, {
                  compactZeroDecimals: true,
                })}
              </span>
            </li>
          ))}
          {ageing.parties.length > 5 && (
            <li className="text-xs text-muted-foreground">
              and {ageing.parties.length - 5} more {partyNoun}
              {ageing.parties.length - 5 === 1 ? "" : "s"}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
