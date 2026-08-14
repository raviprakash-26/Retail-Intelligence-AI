import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Ban } from "lucide-react";
import { VoidDocumentDialog } from "@/components/documents/void-document-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDate } from "@/lib/format";
import { requirePermission } from "@/server/auth/context";
import { getExpense } from "@/server/expenses/expense-service";
import { voidExpenseAction } from "@/server/expenses/actions";
import { MasterDataError } from "@/server/master-data/errors";

export const metadata: Metadata = {
  title: "Expense",
  robots: { index: false, follow: false },
};

export default async function ExpenseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await requirePermission("expenses.view");
  const { id } = await params;

  const detail = await getExpense({
    companyId: context.company.id,
    expenseId: id,
  }).catch((error: unknown) => {
    if (error instanceof MasterDataError) notFound();
    throw error;
  });

  const { expense, entry } = detail;
  const voided = expense.status === "VOIDED";
  const totalTax =
    Number(expense.cgstAmount) +
    Number(expense.sgstAmount) +
    Number(expense.igstAmount);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <Link
        href="/app/expenses"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-3.5" />
        All expenses
      </Link>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex flex-wrap items-center gap-2.5 text-2xl font-semibold tracking-tight">
            <span className={voided ? "line-through" : undefined}>
              {expense.voucherNumber}
            </span>
            {voided ? (
              <Badge variant="danger">
                <Ban className="size-3" />
                Voided
              </Badge>
            ) : (
              <Badge variant="success">Posted</Badge>
            )}
            {expense.isCapitalExpenditure && (
              <Badge variant="info">Asset</Badge>
            )}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatDate(expense.expenseDate, { style: "long" })} ·{" "}
            {expense.category.name}
            {expense.payeeName ? ` · ${expense.payeeName}` : ""}
          </p>
        </div>

        {!voided && context.permissions.has("expenses.void") && (
          <VoidDocumentDialog
            documentId={expense.id}
            documentNumber={expense.voucherNumber}
            noun="expense"
            onVoid={voidExpenseAction}
            placeholder="Recorded against the wrong category"
          />
        )}
      </header>

      {voided && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>This expense was voided</AlertTitle>
          <AlertDescription>
            {expense.voidReason}
            {expense.voidedAt
              ? ` — ${formatDate(expense.voidedAt, { style: "long" })}`
              : ""}
            . The original entry and the reversal that cancels it both remain in
            the ledger.
          </AlertDescription>
        </Alert>
      )}

      {expense.isCapitalExpenditure && !voided && (
        <Alert className="mb-6">
          <AlertTitle>Recorded as an asset, not a cost</AlertTitle>
          <AlertDescription>
            This sits in fixed assets and appears in the asset register as{" "}
            <span className="font-mono">FA-{expense.voucherNumber}</span>. It
            does not reduce this month&rsquo;s profit; depreciation will spread
            the cost across the months it is used.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_16rem]">
        <div className="space-y-6">
          {entry && (
            <Card>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  Journal entry {entry.entryNumber}
                  {entry.status === "REVERSED" && (
                    <Badge variant="muted">Reversed</Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                <Table className="border-0">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-6">Account</TableHead>
                      <TableHead className="text-right">Debit</TableHead>
                      <TableHead className="pr-6 text-right">Credit</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entry.lines.map((line) => (
                      <TableRow key={line.lineNumber}>
                        <TableCell className="pl-6">
                          <p className="text-sm">{line.account.name}</p>
                          <p className="font-mono text-xs text-muted-foreground">
                            {line.account.code}
                          </p>
                        </TableCell>
                        <TableCell className="tabular-figures text-right">
                          {Number(line.debit) === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            formatCurrency(line.debit)
                          )}
                        </TableCell>
                        <TableCell className="tabular-figures pr-6 text-right">
                          {Number(line.credit) === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            formatCurrency(line.credit)
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="border-t px-6 py-3 text-xs leading-relaxed text-muted-foreground">
                  Debits equal credits at {formatCurrency(entry.totalDebit)}.
                  {totalTax > 0 && (
                    <>
                      {" "}
                      {expense.itcEligible
                        ? `The ${formatCurrency(totalTax)} of GST is held as an asset and set against the tax you collect, so it is not part of the cost.`
                        : `The ${formatCurrency(totalTax)} of GST could not be claimed, so it is part of the cost.`}
                    </>
                  )}
                </p>
              </CardContent>
            </Card>
          )}

          {expense.notes && (
            <Card>
              <CardContent className="py-5 text-sm leading-relaxed">
                {expense.notes}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardContent className="space-y-2 py-5 text-sm">
              <Row label="Net of tax" value={expense.taxableAmount} />
              {Number(expense.cgstAmount) > 0 && (
                <Row label="CGST" value={expense.cgstAmount} muted />
              )}
              {Number(expense.sgstAmount) > 0 && (
                <Row label="SGST" value={expense.sgstAmount} muted />
              )}
              {Number(expense.igstAmount) > 0 && (
                <Row label="IGST" value={expense.igstAmount} muted />
              )}
              <div className="flex items-baseline justify-between border-t pt-3">
                <span className="font-medium">Paid</span>
                <span className="tabular-figures text-lg font-semibold">
                  {formatCurrency(expense.totalAmount)}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 py-5 text-sm">
              <Detail
                label="Payment"
                value={expense.paymentMode.toLowerCase()}
              />
              <Detail label="Category" value={expense.category.name} />
              {totalTax > 0 && (
                <Detail
                  label="Input credit"
                  value={expense.itcEligible ? "claimable" : "part of cost"}
                />
              )}
              {expense.referenceNo && (
                <Detail label="Reference" value={expense.referenceNo} mono />
              )}
              {expense.branch && (
                <Detail label="Branch" value={expense.branch.name} />
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  muted,
}: {
  label: string;
  value: unknown;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className={muted ? "text-muted-foreground" : undefined}>
        {label}
      </span>
      <span className="tabular-figures">
        {formatCurrency(String(value as string))}
      </span>
    </div>
  );
}

function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-xs" : "capitalize"}>{value}</span>
    </div>
  );
}
