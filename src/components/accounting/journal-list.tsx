"use client";

import Link from "next/link";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Plus } from "lucide-react";
import {
  ListPagination,
  ListToolbar,
} from "@/components/master-data/list-toolbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDate } from "@/lib/format";
import type { JournalListResult } from "@/server/accounting/journal-service";

/**
 * The journal register.
 *
 * Every entry the books contain, whatever produced it. Most of these were
 * derived from a document, and the "From" column says which — a retailer who
 * clicks through from a journal line to the invoice that caused it has been
 * shown how their own accounting works, which is the whole argument for
 * recording the transaction once.
 *
 * The debit and credit totals underneath cover the entire filtered set rather
 * than the visible page, because "do these balance" is a question about the set.
 */

const VOUCHER_FILTERS = [
  { value: "", label: "All types" },
  { value: "SALES", label: "Sales" },
  { value: "PURCHASE", label: "Purchases" },
  { value: "EXPENSE", label: "Expenses" },
  { value: "RECEIPT", label: "Receipts" },
  { value: "PAYMENT", label: "Payments" },
  { value: "JOURNAL", label: "Journal" },
  { value: "CONTRA", label: "Contra" },
  { value: "DEPRECIATION", label: "Depreciation" },
  { value: "OPENING_BALANCE", label: "Opening balances" },
];

const ORIGIN_FILTERS = [
  { value: "", label: "Everything" },
  { value: "system", label: "From documents" },
  { value: "manual", label: "Posted by hand" },
];

export function JournalList({
  result,
  canCreate,
}: {
  result: JournalListResult;
  canCreate: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function apply(key: string, value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page");
    router.push(`/app/accounting/journal?${next.toString()}` as Route);
  }

  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ListToolbar
          searchPlaceholder="Search by entry number, narration or reference"
          archivedLabel="—"
          hideArchived
        />
        {canCreate && (
          <Button asChild>
            <Link href="/app/accounting/journal/new">
              <Plus className="size-4" />
              New entry
            </Link>
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Filter
          label="Type"
          value={searchParams.get("type") ?? ""}
          options={VOUCHER_FILTERS}
          onChange={(value) => apply("type", value)}
        />
        <Filter
          label="Origin"
          value={searchParams.get("origin") ?? ""}
          options={ORIGIN_FILTERS}
          onChange={(value) => apply("origin", value)}
        />
        <div className="flex items-end gap-2">
          <DateField
            label="From"
            value={from}
            onChange={(value) => apply("from", value)}
          />
          <DateField
            label="To"
            value={to}
            onChange={(value) => apply("to", value)}
          />
        </div>
      </div>

      {result.rows.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <h2 className="text-base font-semibold">Nothing to show</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            No entries match these filters. Every sale, bill, expense, receipt
            and payment you record posts an entry here automatically.
          </p>
        </div>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Entry</TableHead>
                <TableHead>Narration</TableHead>
                <TableHead>From</TableHead>
                <TableHead className="text-right">Lines</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.map((row) => {
                const undone = row.status === "REVERSED";
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <Link
                        href={`/app/accounting/journal/${row.id}` as Route}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        <span className={undone ? "line-through" : undefined}>
                          {row.entryNumber}
                        </span>
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(row.date, { style: "short" })}
                        {row.referenceNo ? ` · ${row.referenceNo}` : ""}
                      </p>
                    </TableCell>
                    <TableCell className="max-w-sm text-sm">
                      <span className="line-clamp-2">
                        {row.narration ?? (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </span>
                      {undone && (
                        <Badge variant="muted" className="mt-1">
                          Reversed
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.source ? (
                        <Badge variant="muted">{row.source}</Badge>
                      ) : (
                        <Badge variant="outline">By hand</Badge>
                      )}
                    </TableCell>
                    <TableCell className="tabular-figures text-right text-sm text-muted-foreground">
                      {row.lineCount}
                    </TableCell>
                    <TableCell className="tabular-figures text-right font-medium">
                      {formatCurrency(row.total, { compactZeroDecimals: true })}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm">
            <span className="text-muted-foreground">
              Across all {result.total}{" "}
              {result.total === 1 ? "entry" : "entries"} matching these filters
            </span>
            <span className="flex flex-wrap items-center gap-4">
              <span>
                <span className="text-muted-foreground">Debits </span>
                <span className="tabular-figures font-medium">
                  {formatCurrency(result.totalDebit, {
                    compactZeroDecimals: true,
                  })}
                </span>
              </span>
              <span>
                <span className="text-muted-foreground">Credits </span>
                <span className="tabular-figures font-medium">
                  {formatCurrency(result.totalCredit, {
                    compactZeroDecimals: true,
                  })}
                </span>
              </span>
              {result.balanced ? (
                <Badge variant="success">Equal</Badge>
              ) : (
                <Badge variant="danger">
                  <AlertTriangle className="size-3" />
                  Not equal
                </Badge>
              )}
            </span>
          </div>
        </>
      )}

      <ListPagination
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        noun="entry"
      />
    </div>
  );
}

function Filter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  // Radix treats "" as "no value", so the all-options entry carries a sentinel.
  const ALL = "__all__";
  return (
    <label className="flex flex-col gap-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Select
        value={value || ALL}
        onValueChange={(next) => onChange(next === ALL ? "" : next)}
      >
        <SelectTrigger className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value || ALL}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="date"
        name={`journal-${label.toLowerCase()}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
      />
    </label>
  );
}
