import Link from "next/link";
import type { Route } from "next";
import { Undo2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatDate } from "@/lib/format";
import type { ReturnSummary } from "@/server/returns/return-queries";

/**
 * Returns already raised against the document being viewed.
 *
 * Shown on the invoice and on the bill, because "why is this ₹11,800 invoice
 * only ₹9,440 in the customer's ledger" is a question the document itself
 * should answer. The original figures are never altered to account for a
 * return, so the link to the note is the only honest way to reconcile them.
 */
export function ReturnsAgainstCard({
  kind,
  rows,
  total,
  documentNoun,
}: {
  kind: "sales" | "purchase";
  rows: readonly ReturnSummary[];
  total: string;
  /** "invoice" or "bill" — used in the sentence under the list. */
  documentNoun: string;
}) {
  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Undo2 className="size-4" />
          {kind === "sales" ? "Credit notes" : "Debit notes"} against this{" "}
          {documentNoun}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <ul className="divide-y">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-baseline justify-between gap-2 py-2 first:pt-0 last:pb-0"
            >
              <div>
                <Link
                  href={`/app/returns/${kind}/${row.id}` as Route}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {row.returnNumber}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {formatDate(row.returnDate, { style: "short" })}
                  {row.reason ? ` · ${row.reason}` : ""}
                </p>
              </div>
              <span className="tabular-figures">
                {formatCurrency(row.totalAmount)}
              </span>
            </li>
          ))}
        </ul>
        <p className="border-t pt-3 text-xs leading-relaxed text-muted-foreground">
          {formatCurrency(total)} has come back against this {documentNoun}. The
          figures above are unchanged by it — a return posts its own entry
          rather than editing the document it reverses.
        </p>
      </CardContent>
    </Card>
  );
}
