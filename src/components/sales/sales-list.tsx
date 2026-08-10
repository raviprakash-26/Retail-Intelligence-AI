"use client";

import Link from "next/link";
import type { Route } from "next";
import { Plus } from "lucide-react";
import {
  ListPagination,
  ListToolbar,
} from "@/components/master-data/list-toolbar";
import { Badge } from "@/components/ui/badge";
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
import { PAYMENT_MODE_LABELS, type PaymentModeInput } from "@/lib/validation/sales";
import type { SaleListResult } from "@/server/sales/sale-service";

/**
 * Invoice list.
 *
 * A voided invoice stays in the list, struck through, rather than disappearing.
 * An invoice number that simply vanishes is the gap in a series that a tax
 * officer asks about, and the honest answer — "it was raised and then voided,
 * here is why" — has to be visible somewhere.
 */
export function SalesList({
  result,
  canCreate,
}: {
  result: SaleListResult;
  canCreate: boolean;
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ListToolbar
          searchPlaceholder="Search by invoice number or customer"
          filterLabel="All invoices"
          filterOptions={[
            { value: "POSTED", label: "Posted" },
            { value: "VOIDED", label: "Voided" },
          ]}
          archivedLabel="—"
          hideArchived
        />
        {canCreate && (
          <Button asChild>
            <Link href="/app/sales/new">
              <Plus className="size-4" />
              New invoice
            </Link>
          </Button>
        )}
      </div>

      {result.rows.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <h2 className="text-base font-semibold">No invoices yet</h2>
          <p className="text-muted-foreground mx-auto mt-1.5 max-w-md text-sm">
            Record your first sale. The journal entry, the stock movement and the
            GST register all follow from it automatically.
          </p>
          {canCreate && (
            <Button asChild className="mt-5">
              <Link href="/app/sales/new">
                <Plus className="size-4" />
                New invoice
              </Link>
            </Button>
          )}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Invoice</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Paid by</TableHead>
              <TableHead className="text-right">Taxable</TableHead>
              <TableHead className="text-right">Tax</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.map((sale) => {
              const voided = sale.status === "VOIDED";
              return (
                <TableRow key={sale.id}>
                  <TableCell>
                    <Link
                      href={`/app/sales/${sale.id}` as Route}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      <span className={voided ? "line-through" : undefined}>
                        {sale.invoiceNumber}
                      </span>
                    </Link>
                    <p className="text-muted-foreground text-xs">
                      {formatDate(sale.invoiceDate, { style: "short" })}
                      {voided && " · voided"}
                    </p>
                  </TableCell>
                  <TableCell className="text-sm">
                    {sale.customerName}
                    {sale.isCredit && sale.dueDate && !voided && (
                      <span className="text-muted-foreground block text-xs">
                        due {formatDate(sale.dueDate, { style: "short" })}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={sale.isCredit ? "warning" : "muted"}>
                      {PAYMENT_MODE_LABELS[sale.paymentMode as PaymentModeInput] ??
                        sale.paymentMode}
                    </Badge>
                  </TableCell>
                  <TableCell className="tabular-figures text-right">
                    {formatCurrency(sale.taxableAmount, {
                      compactZeroDecimals: true,
                    })}
                  </TableCell>
                  <TableCell className="tabular-figures text-right">
                    {Number(sale.taxAmount) === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      formatCurrency(sale.taxAmount, { compactZeroDecimals: true })
                    )}
                  </TableCell>
                  <TableCell className="tabular-figures text-right font-medium">
                    <span className={voided ? "line-through opacity-60" : undefined}>
                      {formatCurrency(sale.totalAmount, {
                        compactZeroDecimals: true,
                      })}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <ListPagination
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        noun="invoice"
      />
    </div>
  );
}
