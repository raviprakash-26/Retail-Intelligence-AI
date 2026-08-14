"use client";

import Link from "next/link";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, CheckCircle2, SlidersHorizontal } from "lucide-react";
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
import { formatCurrency, formatDate, formatNumber } from "@/lib/format";
import type {
  StockReconciliation,
  StockSummary,
} from "@/server/inventory/inventory-report";

/**
 * What is on the shelves.
 *
 * The reconciliation banner is the part that earns its place. Stock is recorded
 * twice — as quantities and as a rupee balance in the books — and a retailer
 * deciding whether to trust their own margin deserves to know the two agree
 * rather than being asked to assume it.
 */
export function StockList({
  summary,
  reconciliation,
  canAdjust,
}: {
  summary: StockSummary;
  reconciliation: StockReconciliation;
  canAdjust: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const filter = searchParams.get("filter") ?? "";

  function applyFilter(value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set("filter", value);
    else next.delete("filter");
    next.delete("page");
    router.push(`/app/inventory?${next.toString()}` as Route);
  }

  return (
    <div className="space-y-5">
      <ReconciliationBanner reconciliation={reconciliation} />

      <div className="grid gap-3 sm:grid-cols-3">
        <Tile
          label="Stock at cost"
          value={formatCurrency(summary.totalValue, {
            compactZeroDecimals: true,
          })}
          note={`${summary.trackedProducts} tracked products`}
        />
        <Tile
          label="At selling price"
          value={formatCurrency(summary.totalSellingValue, {
            compactZeroDecimals: true,
          })}
          note="What it would fetch at list price"
        />
        <Tile
          label="Needs attention"
          value={String(summary.outOfStock + summary.lowStock)}
          note={`${summary.outOfStock} out, ${summary.lowStock} running low`}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <ListToolbar
          searchPlaceholder="Search by name or code"
          archivedLabel="—"
          hideArchived
        />
        <div className="flex items-center gap-2">
          <Button
            variant={filter === "low" ? "default" : "outline"}
            size="sm"
            onClick={() => applyFilter(filter === "low" ? "" : "low")}
          >
            Needs reordering
          </Button>
          {canAdjust && (
            <Button asChild>
              <Link href="/app/inventory/adjust">
                <SlidersHorizontal className="size-4" />
                Correct a count
              </Link>
            </Button>
          )}
        </div>
      </div>

      {summary.rows.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <h2 className="text-base font-semibold">
            {summary.trackedProducts === 0
              ? "No stock-tracked products yet"
              : "Nothing matches"}
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            {summary.trackedProducts === 0
              ? "Add a product with stock tracking turned on and its position will build itself from every bill and invoice you record."
              : "No product matches these filters."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table className="border-0">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Product</TableHead>
                <TableHead className="text-right">On hand</TableHead>
                <TableHead className="text-right">Cost each</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead className="pr-4">Last moved</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.rows.map((row) => (
                <TableRow key={row.productId}>
                  <TableCell className="pl-4">
                    <Link
                      href={`/app/inventory/${row.productId}` as Route}
                      className="text-sm font-medium underline-offset-4 hover:underline"
                    >
                      {row.name}
                    </Link>
                    <p className="font-mono text-xs text-muted-foreground">
                      {row.sku}
                      {row.categoryName ? ` · ${row.categoryName}` : ""}
                    </p>
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="tabular-figures text-sm">
                      {formatNumber(row.quantity)}
                      <span className="ml-1 text-xs text-muted-foreground">
                        {row.unitCode}
                      </span>
                    </span>
                    {row.status !== "OK" && (
                      <p className="mt-0.5">
                        <Badge
                          variant={row.status === "OUT" ? "danger" : "warning"}
                          className="text-[0.625rem]"
                        >
                          {row.status === "OUT"
                            ? "Out of stock"
                            : `Below ${formatNumber(row.minStockLevel)}`}
                        </Badge>
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="tabular-figures text-right text-sm">
                    {formatCurrency(row.averageCost)}
                  </TableCell>
                  <TableCell className="tabular-figures text-right text-sm font-medium">
                    {formatCurrency(row.stockValue, {
                      compactZeroDecimals: true,
                    })}
                  </TableCell>
                  <TableCell className="pr-4 text-xs text-muted-foreground">
                    {row.lastMovementAt
                      ? formatDate(row.lastMovementAt, { style: "short" })
                      : "never"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ListPagination
        page={summary.page}
        pageCount={summary.pageCount}
        total={summary.total}
        noun="product"
      />
    </div>
  );
}

function ReconciliationBanner({
  reconciliation,
}: {
  reconciliation: StockReconciliation;
}) {
  if (reconciliation.agrees) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border px-5 py-3.5">
        <span className="flex items-center gap-2 text-sm font-medium text-success-foreground">
          <CheckCircle2 className="size-4" />
          Stock and the books agree
        </span>
        <span className="text-xs text-muted-foreground">
          The quantities on the shelf and the Inventory account both come to{" "}
          {formatCurrency(reconciliation.ledgerValue, {
            compactZeroDecimals: true,
          })}
          .
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-5 py-4">
      <p className="flex items-center gap-2 text-sm font-medium text-destructive">
        <AlertTriangle className="size-4" />
        Stock and the books disagree
      </p>
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs text-destructive sm:grid-cols-3">
        <Figure label="Stock positions" value={reconciliation.ledgerValue} />
        <Figure
          label="Movements recorded"
          value={reconciliation.movementValue}
        />
        <Figure
          label="Inventory account"
          value={reconciliation.accountBalance}
        />
      </dl>
      <p className="mt-2.5 text-xs leading-relaxed text-destructive">
        These three are written by different parts of the system and should
        always match. A difference means stock moved without the accounting
        following it, or a position was changed outside the application — until
        it is explained, the cost of sales and every margin built on it are
        unreliable. Nothing has been corrected automatically, because that would
        destroy the evidence of how it happened.
      </p>
      {reconciliation.drifted.length > 0 && (
        <ul className="mt-2.5 space-y-1 text-xs text-destructive">
          {reconciliation.drifted.slice(0, 5).map((product) => (
            <li key={product.productId}>
              <span className="font-medium">{product.name}</span> — position
              says {formatCurrency(product.cached)}, its movements come to{" "}
              {formatCurrency(product.fromMovements)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt>{label}</dt>
      <dd className="tabular-figures font-medium">
        {formatCurrency(value, { compactZeroDecimals: true })}
      </dd>
    </div>
  );
}

function Tile({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="rounded-xl border px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="tabular-figures mt-0.5 text-xl font-semibold">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}
