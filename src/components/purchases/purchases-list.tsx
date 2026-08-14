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
import {
  PURCHASE_PAYMENT_LABELS,
  type PurchasePaymentMode,
} from "@/lib/validation/purchases";
import type { PurchaseListResult } from "@/server/purchases/purchase-service";

/**
 * Bill list.
 *
 * The supplier's own reference sits under the internal number, because that is
 * what a retailer holds in their hand when they come looking for a bill.
 */
export function PurchasesList({
  result,
  canCreate,
}: {
  result: PurchaseListResult;
  canCreate: boolean;
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ListToolbar
          searchPlaceholder="Search by bill number or supplier"
          filterLabel="All bills"
          filterOptions={[
            { value: "POSTED", label: "Posted" },
            { value: "VOIDED", label: "Voided" },
          ]}
          archivedLabel="—"
          hideArchived
        />
        {canCreate && (
          <Button asChild>
            <Link href="/app/purchases/new">
              <Plus className="size-4" />
              New bill
            </Link>
          </Button>
        )}
      </div>

      {result.rows.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <h2 className="text-base font-semibold">No bills yet</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            Record what you buy. Stock comes in at what it cost, the GST you
            paid is held as credit against the GST you collect, and what you owe
            the supplier is tracked from the same entry.
          </p>
          {canCreate && (
            <Button asChild className="mt-5">
              <Link href="/app/purchases/new">
                <Plus className="size-4" />
                New bill
              </Link>
            </Button>
          )}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Bill</TableHead>
              <TableHead>Supplier</TableHead>
              <TableHead>Paid by</TableHead>
              <TableHead className="text-right">Taxable</TableHead>
              <TableHead className="text-right">GST</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.map((purchase) => {
              const voided = purchase.status === "VOIDED";
              return (
                <TableRow key={purchase.id}>
                  <TableCell>
                    <Link
                      href={`/app/purchases/${purchase.id}` as Route}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      <span className={voided ? "line-through" : undefined}>
                        {purchase.billNumber}
                      </span>
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {purchase.supplierBillNo
                        ? `their ref ${purchase.supplierBillNo} · `
                        : ""}
                      {formatDate(purchase.billDate, { style: "short" })}
                      {voided && " · voided"}
                    </p>
                  </TableCell>
                  <TableCell className="text-sm">
                    {purchase.supplierName}
                    {purchase.isCredit && purchase.dueDate && !voided && (
                      <span className="block text-xs text-muted-foreground">
                        due {formatDate(purchase.dueDate, { style: "short" })}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={purchase.isCredit ? "warning" : "muted"}>
                      {PURCHASE_PAYMENT_LABELS[
                        purchase.paymentMode as PurchasePaymentMode
                      ] ?? purchase.paymentMode}
                    </Badge>
                  </TableCell>
                  <TableCell className="tabular-figures text-right">
                    {formatCurrency(purchase.taxableAmount, {
                      compactZeroDecimals: true,
                    })}
                  </TableCell>
                  <TableCell className="tabular-figures text-right">
                    {Number(purchase.taxAmount) === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <>
                        {formatCurrency(purchase.taxAmount, {
                          compactZeroDecimals: true,
                        })}
                        {/* Whether the tax is recoverable changes what the
                            goods cost, so it belongs on the row. */}
                        <span className="block text-xs text-muted-foreground">
                          {purchase.itcEligible ? "claimable" : "in cost"}
                        </span>
                      </>
                    )}
                  </TableCell>
                  <TableCell className="tabular-figures text-right font-medium">
                    <span
                      className={voided ? "line-through opacity-60" : undefined}
                    >
                      {formatCurrency(purchase.totalAmount, {
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
        noun="bill"
      />
    </div>
  );
}
