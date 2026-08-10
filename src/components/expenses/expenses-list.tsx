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
  EXPENSE_PAYMENT_LABELS,
  type ExpensePaymentMode,
} from "@/lib/validation/expenses";
import type { ExpenseListResult } from "@/server/expenses/expense-service";

/**
 * Expense list, with what each row did to the books.
 *
 * A capitalised item is badged, because it is sitting in the same list as the
 * costs but is not one — and someone reading the total needs to know which is
 * which.
 */
export function ExpensesList({
  result,
  categories,
  canCreate,
}: {
  result: ExpenseListResult;
  categories: Array<{ id: string; name: string }>;
  canCreate: boolean;
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ListToolbar
          searchPlaceholder="Search by voucher, payee or reference"
          filterLabel="All categories"
          filterOptions={categories.map((category) => ({
            value: category.id,
            label: category.name,
          }))}
          archivedLabel="—"
          hideArchived
        />
        {canCreate && (
          <Button asChild>
            <Link href="/app/expenses/new">
              <Plus className="size-4" />
              Record expense
            </Link>
          </Button>
        )}
      </div>

      {result.rows.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <h2 className="text-base font-semibold">No expenses yet</h2>
          <p className="text-muted-foreground mx-auto mt-1.5 max-w-md text-sm">
            Rent, electricity, salaries, repairs. Each one posts to its own
            expense account, so the profit and loss account adds up without
            anyone sorting receipts at the end of the year.
          </p>
          {canCreate && (
            <Button asChild className="mt-5">
              <Link href="/app/expenses/new">
                <Plus className="size-4" />
                Record expense
              </Link>
            </Button>
          )}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Voucher</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Paid to</TableHead>
              <TableHead>Paid by</TableHead>
              <TableHead className="text-right">GST</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.map((expense) => {
              const voided = expense.status === "VOIDED";
              return (
                <TableRow key={expense.id}>
                  <TableCell>
                    <Link
                      href={`/app/expenses/${expense.id}` as Route}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      <span className={voided ? "line-through" : undefined}>
                        {expense.voucherNumber}
                      </span>
                    </Link>
                    <p className="text-muted-foreground text-xs">
                      {formatDate(expense.expenseDate, { style: "short" })}
                      {voided && " · voided"}
                    </p>
                  </TableCell>
                  <TableCell className="text-sm">
                    {expense.categoryName}
                    {expense.isCapitalExpenditure && (
                      <Badge variant="info" className="ml-1.5 text-[0.625rem]">
                        Asset
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {expense.payeeName ?? (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        expense.paymentMode === "CREDIT" ? "warning" : "muted"
                      }
                    >
                      {EXPENSE_PAYMENT_LABELS[
                        expense.paymentMode as ExpensePaymentMode
                      ] ?? expense.paymentMode}
                    </Badge>
                  </TableCell>
                  <TableCell className="tabular-figures text-right">
                    {Number(expense.taxAmount) === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <>
                        {formatCurrency(expense.taxAmount, {
                          compactZeroDecimals: true,
                        })}
                        <span className="text-muted-foreground block text-xs">
                          {expense.itcEligible ? "claimable" : "in cost"}
                        </span>
                      </>
                    )}
                  </TableCell>
                  <TableCell className="tabular-figures text-right font-medium">
                    <span className={voided ? "line-through opacity-60" : undefined}>
                      {formatCurrency(expense.totalAmount, {
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
        noun="expense"
      />
    </div>
  );
}

/** Where the money went, largest first. Posted revenue expenses only. */
export function ExpenseBreakdown({ result }: { result: ExpenseListResult }) {
  if (result.byCategory.length === 0) return null;

  const largest = Number(result.byCategory[0]?.total ?? 0);
  if (largest <= 0) return null;

  return (
    <div className="mb-6 rounded-xl border px-5 py-4">
      <h2 className="text-sm font-semibold">Where it went</h2>
      <p className="text-muted-foreground mt-0.5 text-xs">
        Posted expenses by category. Assets are excluded — they are not a cost.
      </p>
      <ul className="mt-3 space-y-2">
        {result.byCategory.map((category) => (
          <li key={category.categoryId} className="flex items-center gap-3">
            <span className="w-36 shrink-0 truncate text-sm">
              {category.name}
            </span>
            <span
              className="bg-primary/70 h-2 rounded-full"
              style={{
                width: `${Math.max(2, (Number(category.total) / largest) * 100)}%`,
              }}
              aria-hidden="true"
            />
            <span className="tabular-figures text-muted-foreground ml-auto text-sm">
              {formatCurrency(category.total, { compactZeroDecimals: true })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
