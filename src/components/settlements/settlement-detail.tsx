import Link from "next/link";
import type { Route } from "next";
import { ArrowLeft, FileText, Ban, Info } from "lucide-react";
import { VoidDocumentDialog } from "@/components/documents/void-document-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  SETTLEMENT_MODE_LABELS,
  type SettlementMode,
} from "@/lib/validation/settlements";
import type { ActionResult } from "@/server/auth/action-result";

/**
 * One receipt or one payment, and what it did.
 *
 * Three things are worth seeing together and are almost never shown together:
 * the money, the documents it settled, and the entry it posted. A retailer who
 * can see that ₹5,000 received cleared two invoices and left ₹300 on account
 * knows something the receipt alone would not have told them.
 *
 * A settled document is shown with what it *still* owes after this settlement,
 * read from the invoice itself rather than recomputed here — if the two ever
 * disagreed, the number on this page would be the lie.
 */

export type SettlementAllocationRow = {
  id: string;
  number: string;
  date: Date;
  /** What was matched to this document by this receipt or payment. */
  allocated: string;
  total: string;
  /** What the document still owes, netted for credit and debit notes. */
  outstanding: string;
};

export type SettlementEntryView = {
  entryNumber: string;
  status: string;
  totalDebit: unknown;
  lines: Array<{
    lineNumber: number;
    debit: unknown;
    credit: unknown;
    account: { code: string; name: string };
  }>;
} | null;

export function SettlementDetail({
  id,
  basePath,
  noun,
  documentNoun,
  documentPath,
  voucherNumber,
  date,
  status,
  voidedAt,
  voidReason,
  amount,
  paymentMode,
  referenceNo,
  notes,
  kindLabel,
  partyLabel,
  partyName,
  allocations,
  entry,
  canVoid,
  onVoid,
}: {
  id: string;
  basePath: string;
  /** "receipt" | "payment". */
  noun: string;
  /** "invoice" | "bill". */
  documentNoun: string;
  documentPath: string;
  voucherNumber: string;
  date: Date;
  status: string;
  voidedAt: Date | null;
  voidReason: string | null;
  amount: string;
  paymentMode: string;
  referenceNo: string | null;
  notes: string | null;
  kindLabel: string;
  partyLabel: string;
  partyName: string | null;
  allocations: SettlementAllocationRow[];
  entry: SettlementEntryView;
  canVoid: boolean;
  onVoid: (
    id: string,
    values: { reason: string },
  ) => Promise<ActionResult<{ entryNumber: string }>>;
}) {
  const voided = status === "VOIDED";
  const matched = allocations.reduce(
    (total, row) => total + Number(row.allocated),
    0,
  );
  const onAccount = Number(amount) - matched;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <Link
        href={basePath as Route}
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-3.5" />
        All {noun}s
      </Link>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex flex-wrap items-center gap-2.5 text-2xl font-semibold tracking-tight">
            <span className={voided ? "line-through" : undefined}>
              {voucherNumber}
            </span>
            {voided ? (
              <Badge variant="danger">
                <Ban className="size-3" />
                Voided
              </Badge>
            ) : (
              <Badge variant="success">Posted</Badge>
            )}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatDate(date, { style: "long" })} · {kindLabel}
            {partyName ? ` · ${partyName}` : ""}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {/* Proof the money moved, for the side that would otherwise have
              only our word for it. */}
          <Button asChild variant="outline">
            <Link href={`${basePath}/${id}/voucher` as Route}>
              <FileText aria-hidden="true" />
              Voucher
            </Link>
          </Button>
          {!voided && canVoid && (
            <VoidDocumentDialog
              documentId={id}
              documentNumber={voucherNumber}
              noun={noun}
              onVoid={onVoid}
              placeholder="Recorded twice by mistake"
              description={
                <>
                  The {noun} and its journal entry stay exactly where they are;
                  a reversing entry is posted beside them. Anything this settled
                  becomes outstanding again, so the {documentNoun}s it cleared
                  go back into the ageing report where they belong.
                </>
              }
            />
          )}
        </div>
      </header>

      {voided && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>This {noun} was voided</AlertTitle>
          <AlertDescription>
            {voidReason}
            {voidedAt ? ` — ${formatDate(voidedAt, { style: "long" })}` : ""}.
            The original entry and the reversal that cancels it both remain in
            the ledger, and anything it had settled is outstanding again.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>
                What this settled
                {allocations.length === 0 && (
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    nothing matched
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              {allocations.length === 0 ? (
                <p className="px-6 pb-6 text-sm leading-relaxed text-muted-foreground">
                  {voided
                    ? `This ${noun} was not matched to any ${documentNoun}.`
                    : `This ${noun} sits on account. It has moved the balance in full — it just does not say which ${documentNoun} it was for, so the ageing report cannot attribute it.`}
                </p>
              ) : (
                <>
                  <Table className="border-0">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-6">{documentNoun}</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                        <TableHead className="text-right">
                          Matched here
                        </TableHead>
                        <TableHead className="pr-6 text-right">
                          Still open
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {allocations.map((row) => {
                        const open = Number(row.outstanding);
                        return (
                          <TableRow key={row.id}>
                            <TableCell className="pl-6">
                              <Link
                                href={`${documentPath}/${row.id}` as Route}
                                className="font-medium underline-offset-4 hover:underline"
                              >
                                {row.number}
                              </Link>
                              <p className="text-xs text-muted-foreground">
                                {formatDate(row.date, { style: "short" })}
                              </p>
                            </TableCell>
                            <TableCell className="tabular-figures text-right">
                              {formatCurrency(row.total, {
                                compactZeroDecimals: true,
                              })}
                            </TableCell>
                            <TableCell className="tabular-figures text-right">
                              {formatCurrency(row.allocated, {
                                compactZeroDecimals: true,
                              })}
                            </TableCell>
                            <TableCell className="tabular-figures pr-6 text-right">
                              {open <= 0 ? (
                                <Badge variant="success">Settled</Badge>
                              ) : (
                                formatCurrency(open, {
                                  compactZeroDecimals: true,
                                })
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  {onAccount > 0 && (
                    <p className="flex items-start gap-1.5 border-t px-6 py-3 text-xs leading-relaxed text-muted-foreground">
                      <Info className="mt-0.5 size-3.5 shrink-0" />
                      {formatCurrency(onAccount)} of this {noun} is not matched
                      to any {documentNoun}. It still moved the balance in full.
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>

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
                            formatCurrency(String(line.debit))
                          )}
                        </TableCell>
                        <TableCell className="tabular-figures pr-6 text-right">
                          {Number(line.credit) === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            formatCurrency(String(line.credit))
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="border-t px-6 py-3 text-xs leading-relaxed text-muted-foreground">
                  Debits equal credits at{" "}
                  {formatCurrency(String(entry.totalDebit))}. The entry moves
                  the control account by the whole amount whether or not this{" "}
                  {noun} was matched to a {documentNoun} — matching is a
                  sub-ledger question, not a ledger one.
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardContent className="space-y-2 py-5 text-sm">
              <div className="flex items-baseline justify-between">
                <span className="font-medium">Amount</span>
                <span className="tabular-figures text-lg font-semibold">
                  {formatCurrency(amount)}
                </span>
              </div>
              {allocations.length > 0 && (
                <>
                  <div className="flex items-baseline justify-between border-t pt-3">
                    <span className="text-muted-foreground">Matched</span>
                    <span className="tabular-figures">
                      {formatCurrency(matched)}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-muted-foreground">On account</span>
                    <span className="tabular-figures">
                      {formatCurrency(onAccount)}
                    </span>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 py-5 text-sm">
              <Detail
                label="How"
                value={
                  SETTLEMENT_MODE_LABELS[paymentMode as SettlementMode] ??
                  paymentMode
                }
              />
              <Detail label={partyLabel} value={partyName ?? "—"} />
              <Detail label="For" value={kindLabel} />
              {referenceNo && (
                <Detail label="Reference" value={referenceNo} mono />
              )}
            </CardContent>
          </Card>

          {notes && (
            <Card>
              <CardContent className="py-5 text-sm leading-relaxed">
                {notes}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
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
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-xs" : "text-right"}>{value}</span>
    </div>
  );
}
