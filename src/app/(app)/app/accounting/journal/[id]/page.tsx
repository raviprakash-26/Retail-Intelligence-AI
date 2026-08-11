import type { Metadata } from "next";
import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Undo2 } from "lucide-react";
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
import { reverseJournalEntryAction } from "@/server/accounting/journal-actions";
import {
  documentPath,
  getJournalEntry,
  JournalError,
} from "@/server/accounting/journal-service";

export const metadata: Metadata = {
  title: "Journal entry",
  robots: { index: false, follow: false },
};

/**
 * One entry, its lines, and where it came from.
 *
 * The link back to the originating document is the part worth having. An entry
 * that debits Cash and credits Sales tells you what happened to the ledger; the
 * invoice behind it tells you who bought what. Being able to move between them
 * in one click is what makes the accounting legible rather than merely correct.
 */
export default async function JournalEntryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await requirePermission("accounting.view");
  const { id } = await params;

  const entry = await getJournalEntry({
    companyId: context.company.id,
    entryId: id,
  }).catch((error: unknown) => {
    if (error instanceof JournalError) notFound();
    throw error;
  });

  const reversed = entry.status === "REVERSED";
  const source = documentPath(entry.sourceType, entry.sourceId);
  const canReverse =
    entry.isManual &&
    !reversed &&
    entry.status === "POSTED" &&
    context.permissions.has("accounting.journal.void");

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <Link
        href="/app/accounting/journal"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-3.5" />
        Journal
      </Link>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex flex-wrap items-center gap-2.5 text-2xl font-semibold tracking-tight">
            <span className={reversed ? "line-through" : undefined}>
              {entry.entryNumber}
            </span>
            {reversed ? (
              <Badge variant="danger">
                <Undo2 className="size-3" />
                Reversed
              </Badge>
            ) : entry.status === "POSTED" ? (
              <Badge variant="success">Posted</Badge>
            ) : (
              <Badge variant="muted">{entry.status.toLowerCase()}</Badge>
            )}
            {entry.isManual ? (
              <Badge variant="outline">By hand</Badge>
            ) : (
              entry.source && <Badge variant="muted">{entry.source}</Badge>
            )}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatDate(entry.date, { style: "long" })}
            {entry.branchName ? ` · ${entry.branchName}` : ""}
            {entry.referenceNo ? ` · ${entry.referenceNo}` : ""}
          </p>
        </div>

        {canReverse && (
          <VoidDocumentDialog
            documentId={entry.id}
            documentNumber={entry.entryNumber}
            noun="entry"
            onVoid={reverseJournalEntryAction}
            placeholder="Posted to the wrong account"
            description={
              <>
                Nothing is deleted. This entry stays exactly where it is and a
                mirror of it is posted beside it, so the two cancel out and the
                books show both that it was made and that it was undone.
              </>
            }
          />
        )}
      </header>

      {reversed && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>This entry has been reversed</AlertTitle>
          <AlertDescription>
            {entry.reversedBy ? (
              <>
                Cancelled by{" "}
                <Link
                  href={
                    `/app/accounting/journal/${entry.reversedBy.id}` as Route
                  }
                  className="font-medium underline underline-offset-4"
                >
                  {entry.reversedBy.entryNumber}
                </Link>
                . Both entries remain in the ledger and net to nothing.
              </>
            ) : (
              "Both entries remain in the ledger and net to nothing."
            )}
          </AlertDescription>
        </Alert>
      )}

      {!entry.isManual && (
        <div className="mb-6 rounded-xl border px-5 py-4">
          <p className="text-sm leading-relaxed">
            This entry was produced by a{" "}
            {entry.source?.toLowerCase() ?? "document"}. It cannot be reversed
            from here — voiding the document is what reverses the entry, puts
            back the stock it moved and undoes the settlements that went with
            it. Doing only the accounting half would leave the two disagreeing.
          </p>
          {source && (
            <Link
              href={source as Route}
              className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Open the {entry.source?.toLowerCase() ?? "document"}
              <ArrowUpRight className="size-3.5" />
            </Link>
          )}
        </div>
      )}

      {entry.narration && (
        <Card className="mb-6">
          <CardContent className="py-5 text-sm leading-relaxed">
            {entry.narration}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
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
                    <p className="text-sm">
                      {line.account.name}
                      {line.partyName && (
                        <span className="text-muted-foreground">
                          {" "}
                          — {line.partyName}
                        </span>
                      )}
                    </p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {line.account.code}
                    </p>
                    {line.narration && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {line.narration}
                      </p>
                    )}
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

          <div className="flex items-center justify-between gap-3 border-t px-6 py-3">
            <span className="text-xs leading-relaxed text-muted-foreground">
              Debits equal credits, checked when this was posted and again by
              the database before it was allowed to exist.
            </span>
            <span className="tabular-figures shrink-0 text-lg font-semibold">
              {formatCurrency(entry.total)}
            </span>
          </div>
        </CardContent>
      </Card>

      {entry.reverses && (
        <p className="mt-4 text-sm text-muted-foreground">
          This entry reverses{" "}
          <Link
            href={`/app/accounting/journal/${entry.reverses.id}` as Route}
            className="font-medium underline underline-offset-4"
          >
            {entry.reverses.entryNumber}
          </Link>
          .
        </p>
      )}
    </div>
  );
}
