"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { Lock, LockOpen } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import { Label } from "@/components/ui/label";
import { formatDate } from "@/lib/format";
import {
  closeFiscalYearAction,
  reopenFiscalYearAction,
} from "@/server/accounting/period-actions";
import type { YearCloseView } from "@/server/accounting/year-close-service";

/**
 * Closing the year, as opposed to closing a month.
 *
 * The distinction is worth drawing on the page rather than leaving to the
 * reader: closing a month stops entries going into it, and closing a year moves
 * what was earned in it to retained earnings so the next year starts at nil.
 * Somebody who has closed twelve months has not finished the year, and nothing
 * here should let them believe they have.
 *
 * Reopening asks for a reason in a dialog, exactly as reopening a month does.
 */
export function YearCloseManager({
  years,
  canClose,
}: {
  years: YearCloseView[];
  canClose: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [reopening, setReopening] = React.useState<YearCloseView | null>(null);
  const [reason, setReason] = React.useState("");

  async function close(year: YearCloseView) {
    setPending(year.id);
    const result = await closeFiscalYearAction({ fiscalYearId: year.id });
    setPending(null);
    if (result.ok) {
      toast.success(`${year.label} is closed.`);
      router.refresh();
    } else {
      toast.error(result.message);
    }
  }

  async function reopen() {
    if (!reopening) return;
    setPending(reopening.id);
    const result = await reopenFiscalYearAction({
      fiscalYearId: reopening.id,
      reason,
    });
    setPending(null);
    if (result.ok) {
      toast.success(`${reopening.label} is open again.`);
      setReopening(null);
      setReason("");
      router.refresh();
    } else {
      toast.error(result.message);
    }
  }

  return (
    <>
      <div className="overflow-hidden rounded-xl border">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Financial years and whether each has been closed
            </caption>
            <thead className="border-b bg-muted/40">
              <tr>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  Year
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  Covers
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  State
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {years.map((year) => (
                <tr key={year.id}>
                  <td className="px-4 py-2">
                    <span className="font-medium">{year.label}</span>
                    {year.isCurrent && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        current
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {formatDate(year.startDate, { style: "medium" })} —{" "}
                    {formatDate(year.endDate, { style: "medium" })}
                  </td>
                  <td className="px-4 py-2">
                    {year.closedAt ? (
                      <>
                        <Badge variant="success">
                          Closed{" "}
                          {formatDate(year.closedAt, { style: "medium" })}
                        </Badge>
                        {year.closingEntry && (
                          <Link
                            href={
                              `/app/accounting/journal/${year.closingEntry.id}` as Route
                            }
                            className="ml-2 text-xs underline underline-offset-2"
                          >
                            {year.closingEntry.entryNumber}
                          </Link>
                        )}
                      </>
                    ) : (
                      <>
                        <Badge variant="muted">Open</Badge>
                        {year.openPeriods.length > 0 && (
                          // Naming what it waits on, rather than a disabled
                          // button with no explanation beside it.
                          <span className="ml-2 text-xs text-muted-foreground">
                            {year.openPeriods.length} month
                            {year.openPeriods.length === 1 ? "" : "s"} still
                            open
                          </span>
                        )}
                      </>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {canClose && !year.closedAt && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!year.closable || pending === year.id}
                        onClick={() => close(year)}
                        title={
                          year.closable
                            ? undefined
                            : year.openPeriods.length > 0
                              ? `Close every month of ${year.label} first.`
                              : "An earlier year is still open, and years close in order."
                        }
                      >
                        <Lock className="size-3.5" aria-hidden="true" />
                        Close the year
                      </Button>
                    )}
                    {canClose && year.closedAt && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setReopening(year);
                          setReason("");
                        }}
                      >
                        <LockOpen className="size-3.5" aria-hidden="true" />
                        Reopen
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog
        open={reopening !== null}
        onOpenChange={(open) => !open && setReopening(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reopen {reopening?.label}</DialogTitle>
            <DialogDescription>
              The closing entry is reversed, so what the year earned goes back
              into the income and expense accounts and out of retained earnings.
              Anything posted now will not be in a return already filed for this
              year.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="year-reopen-reason">
              Why is it being reopened?
            </Label>
            <Input
              id="year-reopen-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="An invoice was missed from March"
              maxLength={300}
            />
            <p className="text-xs text-muted-foreground">
              Recorded in the activity log beside the close it undoes.
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setReopening(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={reason.trim().length < 4 || pending !== null}
              onClick={reopen}
            >
              Reopen the year
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
