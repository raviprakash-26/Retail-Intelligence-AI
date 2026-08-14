"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ListPagination,
  ListToolbar,
} from "@/components/master-data/list-toolbar";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDate } from "@/lib/format";
import type { ReturnListResult } from "@/server/returns/return-queries";

/**
 * Credit notes and debit notes, one list at a time.
 *
 * Which direction is showing lives in the URL like every other filter in the
 * product, so a link to "the debit notes" is a link somebody can send. The two
 * are not merged into a single list: they reverse different documents, settle
 * against different parties and appear on opposite sides of the GST return, and
 * a combined total of the two would mean nothing.
 */

const COPY = {
  sales: {
    tab: "Credit notes",
    against: "Invoice",
    party: "Customer",
    empty: "No sales returns yet",
    emptyBody:
      "A return is recorded from the invoice it reverses — open a sale and choose “Record return”. The credit note, the stock coming back and the GST reversal all follow from it.",
    totalLabel: "Credited",
  },
  purchase: {
    tab: "Debit notes",
    against: "Bill",
    party: "Supplier",
    empty: "No purchase returns yet",
    emptyBody:
      "Goods go back to a supplier from the bill they arrived on — open a purchase and choose “Return to supplier”. The debit note reverses the input credit and takes the stock off the shelf.",
    totalLabel: "Debited",
  },
} as const;

export function ReturnsList({
  result,
  canSeeSales,
  canSeePurchases,
}: {
  result: ReturnListResult;
  canSeeSales: boolean;
  canSeePurchases: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const copy = COPY[result.kind];

  function switchTo(kind: "sales" | "purchase") {
    const next = new URLSearchParams(searchParams.toString());
    next.set("type", kind);
    next.delete("page");
    next.delete("q");
    router.replace(`${pathname}?${next.toString()}` as Route);
  }

  const tabs = [
    { kind: "sales" as const, visible: canSeeSales },
    { kind: "purchase" as const, visible: canSeePurchases },
  ].filter((tab) => tab.visible);

  return (
    <div className="space-y-5">
      {tabs.length > 1 && (
        <div className="inline-flex rounded-lg border p-0.5">
          {tabs.map((tab) => (
            <Button
              key={tab.kind}
              variant={result.kind === tab.kind ? "secondary" : "ghost"}
              size="sm"
              onClick={() => switchTo(tab.kind)}
            >
              {COPY[tab.kind].tab}
            </Button>
          ))}
        </div>
      )}

      <ListToolbar
        searchPlaceholder={`Search by note number, ${copy.against.toLowerCase()} or ${copy.party.toLowerCase()}`}
        archivedLabel="—"
        hideArchived
      />

      {result.rows.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <h2 className="text-base font-semibold">{copy.empty}</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
            {copy.emptyBody}
          </p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Note</TableHead>
              <TableHead>{copy.against}</TableHead>
              <TableHead>{copy.party}</TableHead>
              <TableHead className="text-right">Taxable</TableHead>
              <TableHead className="text-right">Tax</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Link
                    href={`/app/returns/${result.kind}/${row.id}` as Route}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {row.returnNumber}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(row.returnDate, { style: "short" })}
                  </p>
                </TableCell>
                <TableCell className="text-sm">
                  {row.againstNumber ?? (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-sm">
                  {row.partyName}
                  {row.reason && (
                    <span className="block max-w-xs truncate text-xs text-muted-foreground">
                      {row.reason}
                    </span>
                  )}
                </TableCell>
                <TableCell className="tabular-figures text-right">
                  {formatCurrency(row.taxableAmount, {
                    compactZeroDecimals: true,
                  })}
                </TableCell>
                <TableCell className="tabular-figures text-right">
                  {Number(row.taxAmount) === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    formatCurrency(row.taxAmount, { compactZeroDecimals: true })
                  )}
                </TableCell>
                <TableCell className="tabular-figures text-right font-medium">
                  {formatCurrency(row.totalAmount, {
                    compactZeroDecimals: true,
                  })}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <ListPagination
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        noun={result.kind === "sales" ? "credit note" : "debit note"}
      />
    </div>
  );
}
