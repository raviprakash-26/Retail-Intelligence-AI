"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Undo2 } from "lucide-react";
import { z } from "zod";
import { FormError } from "@/components/auth/form-error";
import { useServerFormErrors } from "@/components/auth/use-action-form";
import { AmountInput } from "@/components/ui/amount-input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency, formatNumber } from "@/lib/format";
import type { ActionResult } from "@/server/auth/action-result";
import type { ReturnableLine } from "@/server/returns/return-queries";

/**
 * Recording a return against a document that already exists.
 *
 * The dialog opens from the invoice or the bill rather than from a blank page,
 * because a return is meaningless without the document it reverses: the price,
 * the tax rate and the place of supply all come from there, and "you cannot
 * return more than you bought" has no answer without it.
 *
 * So the only thing this form collects per line is a quantity. It shows the
 * rate the original charged and the value of the goods coming back, and says
 * plainly that the tax is worked out on the server — an estimate of GST
 * computed in the browser would be a second implementation of the tax rules,
 * and the two would eventually disagree.
 */

type Direction = "sales" | "purchase";

const WORDING: Record<
  Direction,
  {
    noun: string;
    source: string;
    trigger: string;
    refund: Record<"CREDIT" | "CASH" | "BANK", string>;
    explains: string;
  }
> = {
  sales: {
    noun: "credit note",
    source: "invoice",
    trigger: "Record return",
    refund: {
      CREDIT: "Credit the customer's account",
      CASH: "Refunded from cash",
      BANK: "Refunded by bank transfer",
    },
    explains:
      "Stock comes back at what it originally cost, the revenue and GST are reversed at the rates on the invoice, and the invoice itself is left exactly as it is.",
  },
  purchase: {
    noun: "debit note",
    source: "bill",
    trigger: "Return to supplier",
    refund: {
      CREDIT: "Reduce what you owe the supplier",
      CASH: "Supplier refunded in cash",
      BANK: "Supplier refunded by bank transfer",
    },
    explains:
      "The goods leave stock at what your books carry them at, the input credit claimed on them is given up, and the bill itself is left exactly as it is.",
  },
};

const REFUND_MODES = ["CREDIT", "CASH", "BANK"] as const;

type FormValues = {
  returnDate: string;
  reason: string;
  refundMode: (typeof REFUND_MODES)[number];
  quantities: number[];
};

function buildSchema(lines: readonly ReturnableLine[], minDate: string) {
  return z
    .object({
      returnDate: z
        .string()
        .min(1, "Pick a date.")
        .refine((value) => value >= minDate, {
          message: "A return cannot be dated before the document it reverses.",
        }),
      reason: z
        .string()
        .trim()
        .max(500, "Keep the reason under 500 characters."),
      refundMode: z.enum(REFUND_MODES),
      quantities: z.array(z.number().min(0, "A quantity cannot be negative.")),
    })
    .superRefine((values, ctx) => {
      let any = false;
      values.quantities.forEach((quantity, index) => {
        const line = lines[index];
        if (!line || quantity <= 0) return;
        any = true;
        if (quantity > Number(line.returnable)) {
          ctx.addIssue({
            code: "custom",
            path: ["quantities", index],
            message: `Only ${formatNumber(line.returnable)} left to return.`,
          });
        }
      });
      if (!any) {
        ctx.addIssue({
          code: "custom",
          path: ["quantities"],
          message: "Enter a quantity on at least one line.",
        });
      }
    });
}

export function RecordReturnDialog({
  direction,
  documentNumber,
  documentDate,
  lines,
  onSubmit,
}: {
  direction: Direction;
  documentNumber: string;
  /** ISO date of the invoice or bill; a return cannot precede it. */
  documentDate: string;
  lines: readonly ReturnableLine[];
  onSubmit: (input: {
    returnDate: string;
    reason: string;
    refundMode: "CREDIT" | "CASH" | "BANK";
    lines: Array<{ sourceLineId: string; quantity: number }>;
  }) => Promise<ActionResult<{ returnNumber: string }>>;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const words = WORDING[direction];

  const today = new Date().toISOString().slice(0, 10);
  const defaultDate = today >= documentDate ? today : documentDate;

  const schema = React.useMemo(
    () => buildSchema(lines, documentDate),
    [lines, documentDate],
  );

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      returnDate: defaultDate,
      reason: "",
      refundMode: "CREDIT",
      quantities: lines.map(() => 0),
    },
  });
  const { formError, applyResult } = useServerFormErrors(form);

  const quantities = form.watch("quantities");

  // Exact, and only the goods: quantity times the rate the original charged.
  // The tax is not estimated here — the server computes it from the tax rate
  // the original line carried, which is the only figure a credit note may use.
  const goodsValue = lines.reduce((sum, line, index) => {
    const quantity = quantities[index] ?? 0;
    return quantity > 0 ? sum + quantity * Number(line.rate) : sum;
  }, 0);

  async function submit(values: FormValues) {
    const chosen = lines
      .map((line, index) => ({
        sourceLineId: line.lineId,
        quantity: values.quantities[index] ?? 0,
      }))
      .filter((line) => line.quantity > 0);

    const result = await onSubmit({
      returnDate: values.returnDate,
      reason: values.reason,
      refundMode: values.refundMode,
      lines: chosen,
    });
    if (!applyResult(result)) return;

    setOpen(false);
    form.reset({
      returnDate: defaultDate,
      reason: "",
      refundMode: "CREDIT",
      quantities: lines.map(() => 0),
    });
    router.refresh();
  }

  const nothingLeft = lines.every((line) => Number(line.returnable) <= 0);

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={nothingLeft}
        title={
          nothingLeft
            ? `Everything on this ${words.source} has already been returned.`
            : undefined
        }
      >
        <Undo2 className="size-4" />
        {words.trigger}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Return against {documentNumber}</DialogTitle>
            <DialogDescription>{words.explains}</DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(submit)} className="space-y-5">
              <FormError message={formError} />

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="returnDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Return date</FormLabel>
                      <FormControl>
                        <Input type="date" min={documentDate} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="refundMode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Settlement</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {REFUND_MODES.map((mode) => (
                            <SelectItem key={mode} value={mode}>
                              {words.refund[mode]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Item</th>
                      <th className="px-3 py-2 text-right font-medium">Rate</th>
                      <th className="px-3 py-2 text-right font-medium">
                        Can return
                      </th>
                      <th className="w-32 px-3 py-2 text-right font-medium">
                        Returning
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, index) => {
                      const left = Number(line.returnable);
                      return (
                        <tr
                          key={line.lineId}
                          className="border-b last:border-0"
                        >
                          <td className="px-3 py-2">
                            <p className="font-medium">{line.productName}</p>
                            <p className="font-mono text-xs text-muted-foreground">
                              {line.sku}
                              {Number(line.alreadyReturned) > 0 &&
                                ` · ${formatNumber(line.alreadyReturned)} already returned`}
                            </p>
                          </td>
                          <td className="tabular-figures px-3 py-2 text-right">
                            {formatCurrency(line.rate, {
                              compactZeroDecimals: true,
                            })}
                          </td>
                          <td className="tabular-figures px-3 py-2 text-right text-muted-foreground">
                            {formatNumber(line.returnable)}
                          </td>
                          <td className="px-3 py-2">
                            <FormField
                              control={form.control}
                              name={`quantities.${index}`}
                              render={({ field }) => (
                                <FormItem>
                                  <FormControl>
                                    <AmountInput
                                      name={field.name}
                                      value={field.value}
                                      onChange={field.onChange}
                                      onBlur={field.onBlur}
                                      disabled={left <= 0}
                                      className="text-right"
                                      aria-label={`Quantity of ${line.productName} to return`}
                                    />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {form.formState.errors.quantities?.root?.message && (
                <p className="text-sm text-destructive">
                  {form.formState.errors.quantities.root.message}
                </p>
              )}

              <FormField
                control={form.control}
                name="reason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Why is it coming back?{" "}
                      <span className="font-normal text-muted-foreground">
                        (optional)
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Textarea
                        rows={2}
                        placeholder="Damaged in transit"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm">
                <div className="flex items-baseline justify-between">
                  <span>Goods coming back</span>
                  <span className="tabular-figures font-semibold">
                    {formatCurrency(goodsValue)}
                  </span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  GST is added on top, at the rate and place of supply the{" "}
                  {words.source} carried. It is worked out when the {words.noun}{" "}
                  is posted, not here.
                </p>
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  loading={form.formState.isSubmitting}
                  loadingText="Posting…"
                >
                  Post {words.noun}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  );
}
