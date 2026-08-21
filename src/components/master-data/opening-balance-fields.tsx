"use client";

import type { Control, FieldValues, Path } from "react-hook-form";
import { toast } from "sonner";
import { AmountInput } from "@/components/ui/amount-input";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate } from "@/lib/format";

/**
 * Says so when an opening balance could not be dated to the start of the year.
 *
 * The books put it at the earliest month still open, which is the only date
 * they can honestly hold it once April has been closed. That is a decision the
 * product makes on the shop's behalf, so the shop is told: a figure quietly
 * sitting on a date nobody chose is how a balance sheet stops being trusted.
 *
 * Silent on the ordinary path — `openingDeferredTo` is null whenever the
 * balance landed where the form implied it would, which is nearly always.
 */
export function announceDeferredOpening(dated: string | null, subject: string) {
  if (!dated) return;

  // A bare "2026-07-01" parses as UTC midnight, which renders as the previous
  // day for any browser behind UTC. Midday has no such edge.
  const shown = formatDate(new Date(`${dated}T12:00:00`), { style: "medium" });

  toast.info(`${subject} added, with its opening balance dated ${shown}`, {
    description:
      "The start of the financial year falls in a closed month, so the balance was placed in the earliest month still open.",
  });
}

/**
 * Opening balance for a customer or supplier.
 *
 * Generic over the form's field values so the same control serves both without
 * either schema having to know about the other. The two fields are presented
 * together because they are one fact: an amount without a side is meaningless,
 * and a form that lets you save one without the other invites a receivable
 * being recorded as a payable.
 */
export function OpeningBalanceFields<T extends FieldValues>({
  control,
  amountName,
  natureName,
  debitLabel,
  creditLabel,
  postingNote,
  disabled,
}: {
  control: Control<T>;
  amountName: Path<T>;
  natureName: Path<T>;
  /** What a debit means for this party, in their words. */
  debitLabel: string;
  creditLabel: string;
  postingNote: string;
  disabled?: boolean;
}) {
  return (
    <div className="rounded-lg border bg-muted/30 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          control={control}
          name={amountName}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Opening balance</FormLabel>
              <FormControl>
                <AmountInput
                  prefix="₹"
                  name={field.name}
                  value={field.value as number}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  disabled={disabled}
                  min={0}
                  step="0.01"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name={natureName}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Which way round</FormLabel>
              <Select
                onValueChange={field.onChange}
                value={field.value as string}
                disabled={disabled}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="DEBIT">{debitLabel}</SelectItem>
                  <SelectItem value="CREDIT">{creditLabel}</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      {/* States the accounting consequence up front. An opening balance is not
          a note on a contact card — it posts to the ledger.

          A plain paragraph rather than FormDescription: that component reads
          the surrounding field's context for its id and aria wiring, and this
          text describes the pair of fields, not either one of them. */}
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        {postingNote}
      </p>
    </div>
  );
}
