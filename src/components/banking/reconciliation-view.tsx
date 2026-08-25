"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, Link2Off, Upload } from "lucide-react";
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
import type { SuggestedMatch } from "@/lib/banking/matching";
import type {
  BookMovement,
  StatementMovement,
} from "@/server/banking/reconciliation-service";
import {
  matchTransactionAction,
  recordFromStatementAction,
  unmatchTransactionAction,
} from "@/server/banking/actions";
import { StatementImportDialog } from "./statement-import-dialog";

/**
 * The two sides, and what stands between them.
 *
 * The layout is the paper one: what the bank says on the left, what the books
 * say on the right, and the reconciliation statement underneath. A suggestion
 * is shown with the reason it was suggested, because "same amount, 6 days
 * apart" is something a shopkeeper can judge and a confidence score is not.
 */

type Props = {
  bankAccountId: string;
  statement: StatementMovement[];
  book: BookMovement[];
  unmatchedStatement: StatementMovement[];
  unmatchedBook: BookMovement[];
  suggestions: SuggestedMatch[];
  difference: {
    perBooks: string;
    perStatement: string;
    unpresentedNet: string;
    unrecordedNet: string;
    unexplained: string;
  };
  neverImported: boolean;
  canReconcile: boolean;
  canPost: boolean;
};

const CONFIDENCE_STYLE: Record<SuggestedMatch["confidence"], string> = {
  exact:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  likely: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  possible:
    "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

function money(value: string): string {
  return formatCurrency(Math.abs(Number(value)), { compactZeroDecimals: true });
}

export function ReconciliationView(props: Props) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const statementById = React.useMemo(
    () => new Map(props.statement.map((row) => [row.id, row])),
    [props.statement],
  );
  const bookById = React.useMemo(
    () => new Map(props.book.map((row) => [row.journalEntryId, row])),
    [props.book],
  );

  async function run(
    key: string,
    work: () => Promise<{ ok: boolean; message?: string }>,
  ) {
    setBusy(key);
    setError(null);
    try {
      const result = await work();
      if (!result.ok) setError(result.message ?? "That did not work.");
      else router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const unexplained = Number(props.difference.unexplained);
  const reconciled = unexplained === 0;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {props.statement.length} statement{" "}
          {props.statement.length === 1 ? "line" : "lines"} ·{" "}
          {props.book.length} book{" "}
          {props.book.length === 1 ? "entry" : "entries"} in this window
        </p>
        {props.canReconcile && (
          <StatementImportDialog bankAccountId={props.bankAccountId} />
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-destructive/40 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {props.neverImported ? (
        <div className="rounded-lg border border-dashed px-5 py-10 text-center">
          <Upload className="mx-auto size-5 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">No statement imported yet</p>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            Download a CSV statement from your bank and import it. Nothing is
            posted to your books by importing — the file is evidence to compare
            against what you have already recorded.
          </p>
        </div>
      ) : (
        <>
          {/* ---- The reconciliation statement ------------------------------ */}
          <section className="rounded-lg border">
            <div className="border-b px-4 py-3">
              <h2 className="text-sm font-semibold">
                Reconciliation as at the end of this window
              </h2>
            </div>
            <dl className="divide-y text-sm">
              <Row
                label="Balance as per your books"
                value={props.difference.perBooks}
                signed
              />
              <Row
                label="Less: entries not yet on the statement"
                value={props.difference.unpresentedNet}
                signed
                muted
              />
              <Row
                label="Add: statement lines not yet in your books"
                value={props.difference.unrecordedNet}
                signed
                muted
              />
              <Row
                label="Balance as per the statement"
                value={props.difference.perStatement}
                signed
              />
            </dl>
            <div
              className={
                reconciled
                  ? "flex items-center gap-2 border-t bg-emerald-500/5 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400"
                  : "flex items-center gap-2 border-t bg-destructive/5 px-4 py-3 text-sm text-destructive"
              }
            >
              {reconciled ? (
                <>
                  <Check className="size-4" />
                  <span>
                    Reconciled. Every difference between the two balances is
                    explained by a line above.
                  </span>
                </>
              ) : (
                <span>
                  <strong>{money(props.difference.unexplained)}</strong>{" "}
                  unexplained. The two balances differ by more than the
                  outstanding items account for — something is missing from one
                  side, or a figure disagrees.
                </span>
              )}
            </div>
          </section>

          {/* ---- Suggestions ---------------------------------------------- */}
          {props.suggestions.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold">
                Suggested matches
                <span className="ml-2 font-normal text-muted-foreground">
                  — nothing is matched until you say so
                </span>
              </h2>
              <div className="mt-3 space-y-2">
                {props.suggestions.map((suggestion) => {
                  const line = statementById.get(suggestion.statementId);
                  const entry = bookById.get(suggestion.bookId);
                  if (!line || !entry) return null;
                  const key = `suggest-${suggestion.statementId}`;
                  return (
                    <div
                      key={key}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm">
                          {formatDate(line.txnDate)} · {line.description}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          matches {entry.entryNumber} ·{" "}
                          {entry.narration ?? entry.voucherType} ·{" "}
                          {money(entry.amount)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded-full border px-2.5 py-1 text-xs ${CONFIDENCE_STYLE[suggestion.confidence]}`}
                        >
                          {suggestion.reason}
                        </span>
                        {props.canReconcile && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === key}
                            onClick={() =>
                              run(key, async () => {
                                const result = await matchTransactionAction({
                                  bankTransactionId: suggestion.statementId,
                                  journalEntryId: suggestion.bookId,
                                });
                                return result.ok
                                  ? { ok: true }
                                  : { ok: false, message: result.message };
                              })
                            }
                          >
                            {busy === key ? "Matching…" : "Match"}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* ---- The two sides -------------------------------------------- */}
          <div className="grid gap-6 lg:grid-cols-2">
            <section>
              <h2 className="text-sm font-semibold">
                On the statement, not in your books
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Money the bank has moved that nothing in your books accounts for
                yet.
              </p>
              {props.unmatchedStatement.length === 0 ? (
                <p className="mt-3 rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                  Nothing outstanding.
                </p>
              ) : (
                <Table className="mt-3">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      {props.canPost && <TableHead className="w-32" />}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {props.unmatchedStatement.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="text-xs whitespace-nowrap">
                          {formatDate(row.txnDate)}
                        </TableCell>
                        <TableCell className="max-w-[16rem] truncate text-xs">
                          {row.description}
                        </TableCell>
                        <TableCell className="tabular-figures text-right text-xs whitespace-nowrap">
                          {money(row.amount)}
                          <span className="ml-1 text-muted-foreground">
                            {row.direction === "IN" ? "in" : "out"}
                          </span>
                        </TableCell>
                        {props.canPost && (
                          <TableCell className="text-right">
                            {/*
                              An outstanding line can already be matched — to an
                              entry dated after this window, which is what keeps
                              it outstanding here. Recording it again would be a
                              duplicate, and the action refuses it, so it is not
                              offered.
                            */}
                            {row.matchedEntryId === null ? (
                              <RecordButton row={row} busy={busy} onRun={run} />
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                Matched {row.matchedEntryNumber}
                              </span>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>

            <section>
              <h2 className="text-sm font-semibold">
                In your books, not on the statement
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Usually a cheque that has not been presented yet, or a deposit
                the bank has not credited.
              </p>
              {props.unmatchedBook.length === 0 ? (
                <p className="mt-3 rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                  Nothing outstanding.
                </p>
              ) : (
                <Table className="mt-3">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Entry</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {props.unmatchedBook.map((row) => (
                      <TableRow key={`${row.journalEntryId}-${row.direction}`}>
                        <TableCell className="text-xs whitespace-nowrap">
                          {formatDate(row.entryDate)}
                        </TableCell>
                        <TableCell className="max-w-[16rem] truncate text-xs">
                          <Link
                            href={`/app/accounting/journal/${row.journalEntryId}`}
                            className="underline-offset-2 hover:underline"
                          >
                            {row.entryNumber}
                          </Link>
                          <span className="ml-1.5 text-muted-foreground">
                            {row.narration ?? row.voucherType}
                          </span>
                        </TableCell>
                        <TableCell className="tabular-figures text-right text-xs whitespace-nowrap">
                          {money(row.amount)}
                          <span className="ml-1 text-muted-foreground">
                            {row.direction === "IN" ? "in" : "out"}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
          </div>

          {/* ---- Already matched ------------------------------------------ */}
          <section>
            <h2 className="text-sm font-semibold">Matched</h2>
            {props.statement.filter((row) => row.matchedEntryId).length ===
            0 ? (
              <p className="mt-3 rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                Nothing matched yet.
              </p>
            ) : (
              <Table className="mt-3">
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Statement line</TableHead>
                    <TableHead>Entry</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    {props.canReconcile && <TableHead className="w-28" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {props.statement
                    .filter((row) => row.matchedEntryId)
                    .map((row) => {
                      const key = `unmatch-${row.id}`;
                      return (
                        <TableRow key={row.id}>
                          <TableCell className="text-xs whitespace-nowrap">
                            {formatDate(row.txnDate)}
                          </TableCell>
                          <TableCell className="max-w-[18rem] truncate text-xs">
                            {row.description}
                          </TableCell>
                          <TableCell className="text-xs">
                            <Link
                              href={`/app/accounting/journal/${row.matchedEntryId}`}
                              className="underline-offset-2 hover:underline"
                            >
                              {row.matchedEntryNumber}
                            </Link>
                          </TableCell>
                          <TableCell className="tabular-figures text-right text-xs whitespace-nowrap">
                            {money(row.amount)}
                          </TableCell>
                          {props.canReconcile && (
                            <TableCell className="text-right">
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy === key}
                                onClick={() =>
                                  run(key, async () => {
                                    const result =
                                      await unmatchTransactionAction({
                                        bankTransactionId: row.id,
                                      });
                                    return result.ok
                                      ? { ok: true }
                                      : { ok: false, message: result.message };
                                  })
                                }
                              >
                                <Link2Off className="size-3.5" />
                                Unmatch
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                </TableBody>
              </Table>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  signed,
  muted,
}: {
  label: string;
  value: string;
  signed?: boolean;
  muted?: boolean;
}) {
  const amount = Number(value);
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <dt className={muted ? "text-muted-foreground" : ""}>{label}</dt>
      <dd className="tabular-figures font-medium">
        {formatCurrency(Math.abs(amount), { compactZeroDecimals: true })}
        {signed && amount < 0 && (
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            Cr
          </span>
        )}
      </dd>
    </div>
  );
}

/**
 * Recording a charge or interest straight from the statement line.
 *
 * Offered only for the two items that genuinely originate at the bank. The
 * direction decides which is possible: money out can be a charge or interest
 * paid, money in can only be interest received.
 */
function RecordButton({
  row,
  busy,
  onRun,
}: {
  row: StatementMovement;
  busy: string | null;
  onRun: (
    key: string,
    work: () => Promise<{ ok: boolean; message?: string }>,
  ) => Promise<void>;
}) {
  const key = `record-${row.id}`;
  const kind = row.direction === "OUT" ? "BANK_CHARGE" : "INTEREST_RECEIVED";
  const label = row.direction === "OUT" ? "Bank charge" : "Interest";

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={busy === key}
      title={
        row.direction === "OUT"
          ? "Record this as a bank charge"
          : "Record this as interest received"
      }
      onClick={() =>
        onRun(key, async () => {
          const result = await recordFromStatementAction({
            bankTransactionId: row.id,
            kind,
          });
          return result.ok
            ? { ok: true }
            : { ok: false, message: result.message };
        })
      }
    >
      {busy === key ? "Posting…" : label}
    </Button>
  );
}
