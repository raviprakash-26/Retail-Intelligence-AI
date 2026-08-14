"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Info } from "lucide-react";
import { FormError } from "@/components/auth/form-error";
import { useServerFormErrors } from "@/components/auth/use-action-form";
import {
  DocumentLines,
  DocumentTotals,
} from "@/components/documents/document-lines";
import type { PickerProduct } from "@/components/documents/product-picker";
import { SupplyTypeBar } from "@/components/documents/supply-type-bar";
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
  totalLines,
  type GstRegistration,
} from "@/lib/tax/gst";
import {
  PURCHASE_PAYMENT_LABELS,
  PURCHASE_PAYMENT_MODES,
  purchaseSchema,
  type PurchaseInput,
} from "@/lib/validation/purchases";
import type { ActionResult } from "@/server/auth/action-result";
import {
  createPurchaseAction,
  searchPurchasableProductsAction,
} from "@/server/purchases/actions";

/**
 * The supplier bill form.
 *
 * The mirror of the invoice form, with one question that has no counterpart on
 * the sales side: whether the GST on this bill can be set against the GST
 * collected on sales. The answer changes what the goods cost, so it is asked
 * plainly and its effect is shown before the bill is saved.
 */

export type SupplierOption = {
  id: string;
  name: string;
  gstin: string | null;
  stateCode: string | null;
  creditDays: number;
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyLine() {
  return {
    productId: "",
    description: "",
    quantity: 1,
    rate: 0,
    discountPercent: 0,
  };
}

async function searchProducts(query: string): Promise<PickerProduct[]> {
  const found = await searchPurchasableProductsAction(query);
  return found.map((product) => ({ ...product, price: product.purchasePrice }));
}

export function BillForm({
  suppliers,
  company,
}: {
  suppliers: SupplierOption[];
  company: {
    stateCode: string | null;
    stateName: string | null;
    gstRegistration: GstRegistration;
  };
}) {
  const router = useRouter();

  const form = useForm<PurchaseInput>({
    resolver: zodResolver(purchaseSchema),
    defaultValues: {
      supplierId: "",
      supplierBillNo: "",
      billDate: today(),
      paymentMode: "CREDIT",
      priceIncludesTax: false,
      claimInputCredit: true,
      notes: "",
      lines: [emptyLine()],
    },
  });

  const { formError, applyResult } = useServerFormErrors(form);
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "lines",
  });

  const [picked, setPicked] = React.useState<Record<string, PickerProduct>>({});

  const watched = form.watch();
  const supplier = suppliers.find((entry) => entry.id === watched.supplierId);

  // On a purchase the supplier is the seller, so their registration and their
  // state decide the treatment — not ours.
  const supplyType = resolveSupplyType({
    registration: supplier?.gstin ? "REGULAR" : "UNREGISTERED",
    sellerStateCode: supplier?.stateCode ?? company.stateCode,
    placeOfSupplyStateCode: company.stateCode,
  });

  // Only a regular-scheme buyer can set input tax off against output tax.
  const eligibleForCredit =
    company.gstRegistration === "REGULAR" && chargesTax(supplyType);
  const claiming = eligibleForCredit && watched.claimInputCredit;

  const computed = fields.map((field, index) => {
    const line = watched.lines?.[index];
    const product = picked[field.id];
    return computeLine(
      {
        quantity: line?.quantity ?? 0,
        rate: line?.rate ?? 0,
        discountPercent: line?.discountPercent ?? 0,
        taxPercent: product?.taxPercent ?? 0,
        priceIncludesTax: watched.priceIncludesTax,
      },
      supplyType,
    );
  });

  const totals = totalLines(computed);
  const tax = add(
    totals.cgstAmount,
    totals.sgstAmount,
    totals.igstAmount,
    totals.cessAmount,
  );
  const stockCost = claiming
    ? totals.taxableAmount
    : add(totals.taxableAmount, tax);

  async function onSubmit(values: PurchaseInput) {
    const result: ActionResult<{ id: string }> =
      await createPurchaseAction(values);
    if (!applyResult(result)) return;
    router.push(`/app/purchases/${result.data.id}`);
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <FormError message={formError} />

        <Card>
          <CardContent className="grid gap-5 py-6 sm:grid-cols-2 lg:grid-cols-4">
            <FormField
              control={form.control}
              name="supplierId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Supplier</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a supplier" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className="max-h-72">
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

            <FormField
              control={form.control}
              name="supplierBillNo"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Their bill number</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. 2451" {...field} />
                  </FormControl>
                  <FormDescription>
                    Checked against this supplier&rsquo;s earlier bills.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="billDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Bill date</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="paymentMode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Paid by</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PURCHASE_PAYMENT_MODES.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {PURCHASE_PAYMENT_LABELS[mode]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <SupplyTypeBar
          supplyType={supplyType}
          registration={supplier?.gstin ? "REGULAR" : "UNREGISTERED"}
          placeOfSupply={company.stateCode}
          counterpartyLabel={
            supplier
              ? supplier.gstin
                ? `billed by ${supplier.name}`
                : `${supplier.name} is not GST-registered`
              : null
          }
          control={form.control}
          inclusiveName="priceIncludesTax"
          inclusiveLabel="Rates include GST"
        />

        <DocumentLines
          form={form}
          fields={fields}
          computed={computed}
          picked={picked}
          search={searchProducts}
          showTax={chargesTax(supplyType)}
          onPick={(fieldId, index, selected) => {
            setPicked((current) => ({ ...current, [fieldId]: selected }));
            if (!form.getValues(`lines.${index}.rate`)) {
              form.setValue(`lines.${index}.rate`, Number(selected.price));
            }
          }}
          onRemove={(fieldId, index) => {
            setPicked((current) => {
              const next = { ...current };
              delete next[fieldId];
              return next;
            });
            remove(index);
          }}
          onAdd={() => append(emptyLine())}
        />

        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <div className="space-y-5">
            {chargesTax(supplyType) && (
              <FormField
                control={form.control}
                name="claimInputCredit"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start gap-3 rounded-xl border p-4">
                    <FormControl>
                      <Checkbox
                        checked={field.value && eligibleForCredit}
                        disabled={!eligibleForCredit}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                    <div className="space-y-1">
                      <FormLabel className="font-normal">
                        Claim input tax credit on this bill
                      </FormLabel>
                      <FormDescription className="leading-relaxed">
                        {eligibleForCredit ? (
                          <>
                            The {formatCurrency(tax.toFixed(4))} of GST is held
                            as an asset to set against the tax you collect.
                            Untick it — for goods you cannot claim on — and the
                            tax becomes part of what the stock cost you instead.
                          </>
                        ) : (
                          <>
                            Not available: input credit can only be claimed by a
                            business registered under the regular GST scheme, on
                            a bill that carries GST. The tax on this bill is
                            part of what the goods cost.
                          </>
                        )}
                      </FormDescription>
                    </div>
                  </FormItem>
                )}
              />
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
                    <Textarea rows={3} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <DocumentTotals
            totals={totals}
            extra={
              !tax.isZero() ? (
                <p className="border-t pt-3 text-xs leading-relaxed text-muted-foreground">
                  {claiming ? (
                    <>
                      {formatCurrency(stockCost.toFixed(4))} goes into stock;{" "}
                      {formatCurrency(tax.toFixed(4))} of GST is recoverable and
                      is held separately.
                    </>
                  ) : (
                    <>
                      All {formatCurrency(stockCost.toFixed(4))} goes into stock
                      — the GST is not recoverable, so it is part of the cost.
                    </>
                  )}
                </p>
              ) : undefined
            }
          >
            <p className="flex items-start gap-1.5 pt-1 text-xs leading-relaxed text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              Recalculated on the server when you save. Posting also brings the
              stock in and writes the journal entry.
            </p>

            <Button
              type="submit"
              className="mt-2 w-full"
              loading={form.formState.isSubmitting}
              loadingText="Posting…"
            >
              Post bill
            </Button>
          </DocumentTotals>
        </div>
      </form>
    </Form>
  );
}
