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
  SETTLEMENT_MODE_LABELS,
  type SettlementMode,
} from "@/lib/validation/settlements";
import type { SettlementListResult } from "@/server/settlements/settlement-service";

/**
 * Receipts or payments, listed.
 *
 * The "on account" column is the one worth having: money received that is not
 * matched to an invoice is not lost, but nobody can say what it settled, and a
 * column of them is a to-do list.
 */
export function SettlementsList({
  result,
  kindLabels,
  copy,
  canCreate,
}: {
  result: SettlementListResult;
  kindLabels: Record<string, string>;
  copy: {
    basePath: string;
    newLabel: string;
    emptyTitle: string;
    emptyBody: string;
    noun: string;
    partyHeading: string;
  };
  canCreate: boolean;
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ListToolbar
          searchPlaceholder={`Search by voucher, reference or ${copy.partyHeading.toLowerCase()}`}
          archivedLabel="—"
          hideArchived
        />
        {canCreate && (
          <Button asChild>
            <Link href={`${copy.basePath}/new` as Route}>
              <Plus className="size-4" />
              {copy.newLabel}
            </Link>
          </Button>
        )}
      </div>

      {result.rows.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <h2 className="text-base font-semibold">{copy.emptyTitle}</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            {copy.emptyBody}
          </p>
          {canCreate && (
            <Button asChild className="mt-5">
              <Link href={`${copy.basePath}/new` as Route}>
                <Plus className="size-4" />
                {copy.newLabel}
              </Link>
            </Button>
          )}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Voucher</TableHead>
              <TableHead>{copy.partyHeading}</TableHead>
              <TableHead>For</TableHead>
              <TableHead>How</TableHead>
              <TableHead className="text-right">On account</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.map((row) => {
              const voided = row.status === "VOIDED";
              const onAccount = Number(row.amount) - Number(row.allocated);
              return (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link
                      href={`${copy.basePath}/${row.id}` as Route}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      <span className={voided ? "line-through" : undefined}>
                        {row.voucherNumber}
                      </span>
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(row.date, { style: "short" })}
                      {row.referenceNo ? ` · ${row.referenceNo}` : ""}
                      {voided && " · voided"}
                    </p>
                  </TableCell>
                  <TableCell className="text-sm">
                    {row.partyName ?? (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {kindLabels[row.kind] ?? row.kind}
                  </TableCell>
                  <TableCell>
                    <Badge variant="muted">
                      {SETTLEMENT_MODE_LABELS[
                        row.paymentMode as SettlementMode
                      ] ?? row.paymentMode}
                    </Badge>
                  </TableCell>
                  <TableCell className="tabular-figures text-right">
                    {voided || onAccount <= 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className="text-warning-foreground">
                        {formatCurrency(onAccount, {
                          compactZeroDecimals: true,
                        })}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-figures text-right font-medium">
                    <span
                      className={voided ? "line-through opacity-60" : undefined}
                    >
                      {formatCurrency(row.amount, {
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
        noun={copy.noun}
      />
    </div>
  );
}
