"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Lock, LockOpen, TriangleAlert } from "lucide-react";
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
  closePeriodAction,
  reopenPeriodAction,
} from "@/server/accounting/period-actions";
import type { PeriodView } from "@/server/accounting/period-service";

/**
 * Which months are settled and which are still moving.
 *
 * Closing is the ordinary act and gets a plain button. Reopening asks for a
 * reason in a dialog, because it means the figures behind something that may
 * already have been filed can change — and because the reason is what somebody
 * reading the activity log in six months will need.
 */
export function PeriodManager({
  periods,
  canClose,
}: {
  periods: PeriodView[];
  canClose: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [reopening, setReopening] = React.useState<PeriodView | null>(null);
  const [reason, setReason] = React.useState("");

  async function close(period: PeriodView) {
    setPending(period.id);
    const result = await closePeriodAction({ periodId: period.id });
    setPending(null);
    if (result.ok) {
      toast.success(`${period.label} is closed.`);
      router.refresh();
    } else {
      toast.error(result.message);
    }
  }

  async function reopen() {
    if (!reopening) return;
    setPending(reopening.id);
    const result = await reopenPeriodAction({
      periodId: reopening.id,
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
              Accounting periods and whether they are still open
            </caption>
            <thead className="border-b bg-muted/40">
              <tr>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  Period
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  Covers
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Entries
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
              {periods.map((period) => (
                <tr key={period.id}>
                  <td className="px-4 py-2">
                    <span className="font-medium">{period.label}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {period.fiscalYearLabel}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {formatDate(period.startDate, { style: "medium" })} —{" "}
                    {formatDate(period.endDate, { style: "medium" })}
                  </td>
                  <td className="tabular-figures px-4 py-2 text-right">
                    {period.postedEntries}
                  </td>
                  <td className="px-4 py-2">
                    {period.status === "OPEN" ? (
                      <Badge variant="muted">Open</Badge>
                    ) : period.status === "CLOSED" ? (
                      <Badge variant="success">
                        Closed
                        {period.closedAt
                          ? ` ${formatDate(period.closedAt, { style: "medium" })}`
                          : ""}
                      </Badge>
                    ) : (
                      <Badge variant="warning">Locked</Badge>
                    )}
                    {period.pending.journalDrafts > 0 && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {period.pending.journalDrafts} draft
                        {period.pending.journalDrafts === 1 ? "" : "s"}
                      </span>
                    )}
                    {/*
                      Why the Reopen button beside it is greyed out. A disabled
                      button's `title` does not fire on hover in every browser,
                      so the reason has to be readable without one.
                    */}
                    {period.fiscalYearClosed && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        year closed
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {canClose && period.status === "OPEN" && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!period.closable || pending === period.id}
                        onClick={() => close(period)}
                        title={
                          period.closable
                            ? undefined
                            : "Post or discard the drafts in this period first."
                        }
                      >
                        <Lock className="size-3.5" aria-hidden="true" />
                        Close
                      </Button>
                    )}
                    {canClose && period.status === "CLOSED" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={!period.reopenable || pending === period.id}
                        onClick={() => {
                          setReopening(period);
                          setReason("");
                        }}
                        title={
                          period.reopenable
                            ? undefined
                            : `${period.fiscalYearLabel} has been closed. Reopen the year first, under Financial years below.`
                        }
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
        onOpenChange={(next) => {
          if (!next) {
            setReopening(null);
            setReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reopen {reopening?.label}</DialogTitle>
            <DialogDescription>
              Entries can be posted into this period again, which means figures
              you may already have filed on can change. The reason is kept with
              the record.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-start gap-2 rounded-lg bg-warning-muted px-3 py-2 text-xs text-warning-strong">
            <TriangleAlert
              className="mt-0.5 size-3.5 shrink-0"
              aria-hidden="true"
            />
            <p>
              If a return has been filed for this period, anything posted now
              will not be in it.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="reopen-reason">Why is it being reopened?</Label>
            <Input
              id="reopen-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="A supplier bill arrived late and belongs in this month"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              onClick={reopen}
              disabled={reason.trim().length < 4 || pending !== null}
            >
              Reopen the period
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
