"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Building2, Info } from "lucide-react";
import { FormError } from "@/components/auth/form-error";
import { useServerFormErrors } from "@/components/auth/use-action-form";
import { AmountInput } from "@/components/ui/amount-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormDescription,
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
import { formatCurrency } from "@/lib/format";
import { add } from "@/lib/money";
import {
  chargesTax,
  computeLine,
  resolveSupplyType,
  type GstRegistration,
} from "@/lib/tax/gst";
import {
  EXPENSE_PAYMENT_LABELS,
  EXPENSE_PAYMENT_MODES,
  EXPENSE_TAX_RATES,
  expenseSchema,
  type ExpenseInput,
} from "@/lib/validation/expenses";
import type { ActionResult } from "@/server/auth/action-result";
import { createExpenseAction } from "@/server/expenses/actions";

/**
 * The expense form.
 *
 * Most of it is one amount and one category. The two controls that carry real
 * weight — capital versus revenue, and whether the GST can be claimed — are
 * given their own space and say what they will do, because both change the
 * profit figure and neither is obvious from the receipt in someone's hand.
 */

export type ExpenseCategoryOption = { id: string; name: string };
export type PayeeOption = {
  id: string;
  name: string;
  gstin: string | null;
  stateCode: string | null;
};

const NO_SUPPLIER = "__other";

export function ExpenseForm({
  categories,
  suppliers,
  company,
  today,
}: {
  categories: ExpenseCategoryOption[];
  suppliers: PayeeOption[];
  company: { stateCode: string | null; gstRegistration: GstRegistration };
  /** The shop's own calendar day, worked out from its time zone. */
  today: string;
}) {
  const router = useRouter();

  const form = useForm<ExpenseInput>({
    resolver: zodResolver(expenseSchema),
    defaultValues: {
      categoryId: "",
      expenseDate: today,
      paymentMode: "CASH",
      supplierId: "",
      payeeName: "",
      amount: 0,
      taxPercent: 0,
      amountIncludesTax: true,
      claimInputCredit: true,
      isCapitalExpenditure: false,
      assetName: "",
      assetUsefulLifeMonths: 60,
      referenceNo: "",
      notes: "",
    },
  });

  const { formError, applyResult } = useServerFormErrors(form);
  const watched = form.watch();

  const supplier = suppliers.find((entry) => entry.id === watched.supplierId);

  const supplyType =
    watched.taxPercent > 0
      ? resolveSupplyType({
          registration: "REGULAR",
          sellerStateCode: supplier?.stateCode ?? company.stateCode,
          placeOfSupplyStateCode: company.stateCode,
        })
      : "NON_GST";

  const computed = computeLine(
    {
      quantity: 1,
      rate: watched.amount || 0,
      taxPercent: watched.taxPercent || 0,
      priceIncludesTax: watched.amountIncludesTax,
    },
    supplyType,
  );

  const tax = add(
    computed.cgstAmount,
    computed.sgstAmount,
    computed.igstAmount,
  );
  const eligibleForCredit =
    company.gstRegistration === "REGULAR" && chargesTax(supplyType);
  const claiming =
    eligibleForCredit && watched.claimInputCredit && !tax.isZero();
  const carriedCost = claiming
    ? computed.taxableAmount
    : add(computed.taxableAmount, tax);

  async function onSubmit(values: ExpenseInput) {
    const result: ActionResult<{ id: string }> =
      await createExpenseAction(values);
    if (!applyResult(result)) return;
    router.push(`/app/expenses/${result.data.id}`);
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <FormError message={formError} />

        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <div className="space-y-6">
            <Card>
              <CardContent className="grid gap-5 py-6 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="categoryId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>What was it for</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Choose a category" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="max-h-72">
                          {categories.map((category) => (
                            <SelectItem key={category.id} value={category.id}>
                              {category.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        Decides which expense account it posts to.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="expenseDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Date</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="supplierId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Paid to</FormLabel>
                      <Select
                        onValueChange={(value) =>
                          field.onChange(value === NO_SUPPLIER ? "" : value)
                        }
                        value={field.value || NO_SUPPLIER}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="max-h-72">
                          <SelectItem value={NO_SUPPLIER}>
                            Someone else — type their name
                          </SelectItem>
                          {suppliers.map((entry) => (
                            <SelectItem key={entry.id} value={entry.id}>
                              {entry.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {!watched.supplierId && (
                  <FormField
                    control={form.control}
                    name="payeeName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Payee
                          <span className="font-normal text-muted-foreground">
                            (optional)
                          </span>
                        </FormLabel>
                        <FormControl>
                          <Input placeholder="BESCOM" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                <FormField
                  control={form.control}
                  name="paymentMode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Paid by</FormLabel>
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
                          {EXPENSE_PAYMENT_MODES.map((mode) => (
                            <SelectItem key={mode} value={mode}>
                              {EXPENSE_PAYMENT_LABELS[mode]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="referenceNo"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Bill or receipt number
                        <span className="font-normal text-muted-foreground">
                          (optional)
                        </span>
                      </FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-5 py-6">
                <div className="grid gap-5 sm:grid-cols-3">
                  <FormField
                    control={form.control}
                    name="amount"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Amount</FormLabel>
                        <FormControl>
                          <AmountInput
                            prefix="₹"
                            autoFocus
                            name={field.name}
                            value={field.value}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            min={0}
                            step="0.01"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="taxPercent"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>GST on the receipt</FormLabel>
                        <Select
                          onValueChange={(value) =>
                            field.onChange(Number(value))
                          }
                          value={String(field.value)}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {EXPENSE_TAX_RATES.map((rate) => (
                              <SelectItem key={rate} value={String(rate)}>
                                {rate === 0 ? "No GST" : `${rate}%`}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="amountIncludesTax"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-center gap-2 pt-8">
                        <FormControl>
                          <Checkbox
                            id="amount-includes-tax"
                            checked={field.value}
                            onCheckedChange={field.onChange}
                            disabled={!watched.taxPercent}
                          />
                        </FormControl>
                        <FormLabel
                          htmlFor="amount-includes-tax"
                          className="font-normal"
                        >
                          Amount includes GST
                        </FormLabel>
                      </FormItem>
                    )}
                  />
                </div>

                {!tax.isZero() && (
                  <FormField
                    control={form.control}
                    name="claimInputCredit"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-start gap-3 rounded-lg border p-4">
                        <FormControl>
                          <Checkbox
                            checked={field.value && eligibleForCredit}
                            disabled={!eligibleForCredit}
                            onCheckedChange={field.onChange}
                          />
                        </FormControl>
                        <div className="space-y-1">
                          <FormLabel className="font-normal">
                            Claim input tax credit
                          </FormLabel>
                          <FormDescription className="leading-relaxed">
                            {eligibleForCredit
                              ? `The ${formatCurrency(tax.toFixed(4))} of GST is set against the tax you collect, so only ${formatCurrency(computed.taxableAmount.toFixed(4))} is a cost.`
                              : "Not available: input credit can only be claimed by a business registered under the regular GST scheme. The tax here is part of the cost."}
                          </FormDescription>
                        </div>
                      </FormItem>
                    )}
                  />
                )}

                <FormField
                  control={form.control}
                  name="isCapitalExpenditure"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start gap-3 rounded-lg border p-4">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <div className="space-y-1">
                        <FormLabel className="font-normal">
                          This is something the shop will keep and use
                        </FormLabel>
                        <FormDescription className="leading-relaxed">
                          A fridge, a counter, a computer. It is an asset that
                          wears out over years, not a cost of this month —
                          recording it as an expense understates profit now and
                          overstates it every month afterwards.
                        </FormDescription>
                      </div>
                    </FormItem>
                  )}
                />

                {watched.isCapitalExpenditure && (
                  <div className="grid gap-5 sm:grid-cols-[1fr_10rem]">
                    <FormField
                      control={form.control}
                      name="assetName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>What is it</FormLabel>
                          <FormControl>
                            <Input placeholder="Display fridge" {...field} />
                          </FormControl>
                          <FormDescription>
                            Goes into the asset register under this name.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="assetUsefulLifeMonths"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Useful life</FormLabel>
                          <FormControl>
                            <AmountInput
                              name={field.name}
                              value={field.value}
                              onChange={field.onChange}
                              onBlur={field.onBlur}
                              min={1}
                              max={600}
                              step="1"
                            />
                          </FormControl>
                          <FormDescription>months</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                )}

                <FormField
                  control={form.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Notes
                        <span className="font-normal text-muted-foreground">
                          (optional)
                        </span>
                      </FormLabel>
                      <FormControl>
                        <Textarea rows={2} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>
          </div>

          <Card className="h-fit">
            <CardContent className="space-y-2 py-5 text-sm">
              {supplier?.gstin && (
                <p className="flex items-center gap-1.5 pb-2 text-xs text-muted-foreground">
                  <Building2 className="size-3.5" />
                  {supplier.name} · {supplier.gstin}
                </p>
              )}

              <div className="flex items-baseline justify-between">
                <span>Net of tax</span>
                <span className="tabular-figures">
                  {formatCurrency(computed.taxableAmount.toFixed(4))}
                </span>
              </div>
              {!tax.isZero() && (
                <div className="flex items-baseline justify-between">
                  <span className="text-muted-foreground">
                    GST{" "}
                    {supplyType === "INTER_STATE" ? "(IGST)" : "(CGST + SGST)"}
                  </span>
                  <span className="tabular-figures">
                    {formatCurrency(tax.toFixed(4))}
                  </span>
                </div>
              )}

              <div className="flex items-baseline justify-between border-t pt-3">
                <span className="font-medium">Paid</span>
                <span className="tabular-figures text-lg font-semibold">
                  {formatCurrency(computed.lineTotal.toFixed(4))}
                </span>
              </div>

              {/* The figure that actually reaches the profit and loss account,
                  which is not always the figure on the receipt. */}
              <div className="flex items-baseline justify-between border-t pt-3">
                <span className="text-muted-foreground">
                  {watched.isCapitalExpenditure
                    ? "Added to assets"
                    : "Cost this month"}
                </span>
                <span className="tabular-figures font-medium">
                  {watched.isCapitalExpenditure
                    ? formatCurrency(carriedCost.toFixed(4))
                    : formatCurrency(carriedCost.toFixed(4))}
                </span>
              </div>

              {watched.isCapitalExpenditure && (
                <Badge variant="info" className="mt-1">
                  Not a cost of this month
                </Badge>
              )}

              <p className="flex items-start gap-1.5 pt-2 text-xs leading-relaxed text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                Recalculated on the server when you save, and posted as a
                balanced journal entry.
              </p>

              <Button
                type="submit"
                className="mt-2 w-full"
                loading={form.formState.isSubmitting}
                loadingText="Recording…"
              >
                Record expense
              </Button>
            </CardContent>
          </Card>
        </div>
      </form>
    </Form>
  );
}
