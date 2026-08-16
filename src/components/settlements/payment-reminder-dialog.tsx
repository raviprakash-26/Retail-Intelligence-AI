"use client";

import * as React from "react";
import { Mail, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/format";
import {
  reminderPreviewAction,
  sendPaymentReminderAction,
} from "@/server/settlements/reminder-actions";
import type { ReminderPreview } from "@/server/settlements/payment-reminder";

/**
 * Asking a customer for money, after seeing exactly what will be said.
 *
 * The preview is the point. A reminder is the shop speaking to its customer in
 * its own name, and a figure that turns out to be wrong costs more than the
 * invoice — so every invoice that will be named is listed first, with what is
 * owed on it and how late it is, and nothing is sent until somebody has looked.
 *
 * When it was last sent is shown too. A customer who receives three reminders
 * in a week stops reading them, and the person clicking has no other way to
 * know a colleague already did it this morning.
 */
export function PaymentReminderDialog({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [preview, setPreview] = React.useState<ReminderPreview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [sent, setSent] = React.useState(false);

  async function load() {
    setPending(true);
    setError(null);
    const result = await reminderPreviewAction({ customerId });
    setPending(false);
    if (result.ok) setPreview(result.data);
    else setError(result.message);
  }

  async function send() {
    setPending(true);
    const result = await sendPaymentReminderAction({ customerId });
    setPending(false);
    if (result.ok) {
      toast.success(`Reminder sent to ${result.data.to}`);
      setSent(true);
      setOpen(false);
    } else {
      setError(result.message);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setPreview(null);
          setSent(false);
          void load();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Send a payment reminder to ${customerName}`}
        >
          <Mail className="size-3.5" aria-hidden="true" />
          Remind
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Remind {customerName}</DialogTitle>
          <DialogDescription>
            This is exactly what will be sent. It states what is owed and
            nothing else — no interest, no penalty, and no claim about what
            happens next.
          </DialogDescription>
        </DialogHeader>

        {pending && !preview && (
          <p className="text-sm text-muted-foreground" aria-live="polite">
            Reading the account…
          </p>
        )}

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        {preview && (
          <div className="space-y-3">
            {preview.lastRemindedAt && !sent && (
              <p className="rounded-lg bg-warning-muted px-3 py-2 text-xs text-warning-strong">
                Last reminded {formatDateTime(preview.lastRemindedAt)}.
              </p>
            )}

            {preview.customer.email ? (
              <p className="text-sm">
                To <span className="font-medium">{preview.customer.email}</span>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                This customer has no email address on record. Add one on the
                customer to send them a reminder.
              </p>
            )}

            {preview.invoices.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing is outstanding, so there is nothing to remind them
                about.
              </p>
            ) : (
              <>
                <ul className="divide-y rounded-lg border text-sm">
                  {preview.invoices.map((invoice) => (
                    <li
                      key={invoice.id}
                      className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2"
                    >
                      <span>
                        {invoice.number}
                        <span className="ml-2 text-xs text-muted-foreground">
                          due{" "}
                          {formatDate(new Date(invoice.dueDate), {
                            style: "medium",
                          })}
                          {invoice.daysOverdue > 0
                            ? ` · ${invoice.daysOverdue}d overdue`
                            : " · not yet due"}
                        </span>
                      </span>
                      <span className="tabular-figures">
                        {formatCurrency(invoice.outstanding)}
                      </span>
                    </li>
                  ))}
                </ul>

                <div className="flex items-baseline justify-between text-sm font-medium">
                  <span>Total outstanding</span>
                  <span className="tabular-figures">
                    {formatCurrency(preview.totalOutstanding)}
                  </span>
                </div>
                {Number(preview.totalOverdue) > 0 && (
                  <div className="flex items-baseline justify-between text-sm text-destructive">
                    <span>Of which past due</span>
                    <span className="tabular-figures">
                      {formatCurrency(preview.totalOverdue)}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            onClick={send}
            disabled={
              pending ||
              !preview?.customer.email ||
              (preview?.invoices.length ?? 0) === 0
            }
          >
            <Send aria-hidden="true" />
            {pending ? "Sending…" : "Send the reminder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
