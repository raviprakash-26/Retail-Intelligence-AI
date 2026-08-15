"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { importStatementAction } from "@/server/banking/actions";
import type { ImportSummary } from "@/server/banking/statement-import";

/**
 * Uploading a statement.
 *
 * The file is read in the browser and sent as text — it is parsed on the
 * server, because a parser that ran on the client would be a parser somebody
 * could edit the output of. What comes back is a count of what was imported,
 * what was already there, and which lines could not be read, all of which are
 * shown rather than summarised as "done".
 */
export function StatementImportDialog({
  bankAccountId,
}: {
  bankAccountId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [summary, setSummary] = React.useState<ImportSummary | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file) {
      setError("Choose a CSV file to import.");
      return;
    }

    setPending(true);
    setError(null);
    setSummary(null);
    try {
      const content = await file.text();
      const result = await importStatementAction({
        bankAccountId,
        content,
        fileName: file.name,
      });
      if (result.ok) {
        setSummary(result.data);
        router.refresh();
      } else {
        setError(result.message);
      }
    } catch {
      setError("That file could not be read.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setError(null);
          setSummary(null);
          setOpen(true);
        }}
      >
        <Upload className="size-4" />
        Import statement
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import a bank statement</DialogTitle>
            <DialogDescription>
              A CSV downloaded from your bank. Importing records what the
              statement says — it does not post anything to your books.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={onSubmit} className="space-y-4">
            <Input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              aria-label="Statement CSV file"
              disabled={pending}
            />

            <p className="text-xs leading-relaxed text-muted-foreground">
              Most bank exports work as they are: the columns are matched by
              name, and dates are read day-first the way Indian statements print
              them. Importing the same range twice is safe — lines already
              present are skipped rather than added again.
            </p>

            {error && (
              <p className="rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            {summary && (
              <div className="rounded-lg border px-3 py-2.5 text-sm">
                <p className="font-medium">
                  {summary.imported} line{summary.imported === 1 ? "" : "s"}{" "}
                  imported
                </p>
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {summary.duplicates > 0 && (
                    <li>
                      {summary.duplicates} already imported, so skipped rather
                      than duplicated.
                    </li>
                  )}
                  {summary.skipped.length > 0 && (
                    <li>
                      {summary.skipped.length} could not be read:{" "}
                      {summary.skipped
                        .slice(0, 3)
                        .map((row) => `line ${row.lineNumber} (${row.message})`)
                        .join("; ")}
                      {summary.skipped.length > 3 ? "…" : ""}
                    </li>
                  )}
                  {summary.imported === 0 &&
                    summary.duplicates === 0 &&
                    summary.skipped.length === 0 && (
                      <li>There was nothing in the file to import.</li>
                    )}
                </ul>
              </div>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
              >
                {summary ? "Done" : "Cancel"}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Importing…" : "Import"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
