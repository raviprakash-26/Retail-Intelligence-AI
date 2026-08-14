"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Info, TriangleAlert } from "lucide-react";
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
import {
  chargesTax,
  computeLine,
  resolveSupplyType,
  totalLines,
  type GstRegistration,
} from "@/lib/tax/gst";
import {
  PAYMENT_MODES,
  PAYMENT_MODE_LABELS,
  saleSchema,
  type SaleInput,
} from "@/lib/validation/sales";
import type { ActionResult } from "@/server/auth/action-result";
import { searchSellableProductsAction } from "@/server/sales/actions";
import { createSaleAction } from "@/server/sales/actions";

/**
 * The invoice form.
 *
 * Totals are shown live using the same tax engine the server posts with, so
 * what the retailer sees before saving is what the books will say afterwards.
 * The figures still travel nowhere: the action sends products, quantities,
 * rates and discounts, and the server recomputes everything.
 */

export type CustomerOption = {
  id: string;
  name: string;
  gstin: string | null;
  stateCode: string | null;
  creditDays: number;
};

const NO_CUSTOMER = "__walkin";

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
  const found = await searchSellableProductsAction(query);
  return found.map((product) => ({ ...product, price: product.sellingPrice }));
}

export function InvoiceForm({
  customers,
  company,
}: {
  customers: CustomerOption[];
  company: {
    stateCode: string | null;
    stateName: string | null;
    gstRegistration: GstRegistration;
  };
}) {
  const router = useRouter();

  const form = useForm<SaleInput>({
    resolver: zodResolver(saleSchema),
    defaultValues: {
      customerId: "",
      invoiceDate: today(),
      paymentMode: "CASH",
      placeOfSupply: "",
      priceIncludesTax: false,
      notes: "",
      lines: [emptyLine()],
    },
  });

  const { formError, applyResult } = useServerFormErrors(form);
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "lines",
  });

  // Product details for each line, keyed by field id. Kept beside the form
  // rather than inside it because they are reference data the server owns —
  // the form only carries the id it chose.
  const [picked, setPicked] = React.useState<Record<string, PickerProduct>>({});

  const watched = form.watch();
  const customer = customers.find((entry) => entry.id === watched.customerId);

  const placeOfSupply =
    watched.placeOfSupply || customer?.stateCode || company.stateCode || null;

  const supplyType = resolveSupplyType({
    registration: company.gstRegistration,
    sellerStateCode: company.stateCode,
    placeOfSupplyStateCode: placeOfSupply,
  });

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

  const shortages = fields.flatMap((field, index) => {
    const product = picked[field.id];
    const quantity = watched.lines?.[index]?.quantity ?? 0;
    if (!product?.isStockTracked) return [];
    const available = Number(product.stockOnHand ?? 0);
    if (quantity <= available) return [];
    return [
      `${product.name}: ${available} ${product.unitCode} in stock, ${quantity} on this invoice`,
    ];
  });

  async function onSubmit(values: SaleInput) {
    const result: ActionResult<{ id: string }> = await createSaleAction(values);
    if (!applyResult(result)) return;
    router.push(`/app/sales/${result.data.id}`);
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <FormError message={formError} />

        <Card>
          <CardContent className="grid gap-5 py-6 sm:grid-cols-2 lg:grid-cols-4">
            <FormField
              control={form.control}
              name="customerId"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Customer</FormLabel>
                  <Select
                    onValueChange={(value) =>
                      field.onChange(value === NO_CUSTOMER ? "" : value)
                    }
                    value={field.value || NO_CUSTOMER}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className="max-h-72">
                      <SelectItem value={NO_CUSTOMER}>
                        Walk-in — no customer record
                      </SelectItem>
                      {customers.map((entry) => (
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
              name="invoiceDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Invoice date</FormLabel>
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
                      {PAYMENT_MODES.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {PAYMENT_MODE_LABELS[mode]}
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
          registration={company.gstRegistration}
          placeOfSupply={placeOfSupply}
          counterpartyLabel={
            company.stateName ? `you supply from ${company.stateName}` : null
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
          warnWhenEmpty
          showTax={chargesTax(supplyType)}
          onPick={(fieldId, index, selected) => {
            setPicked((current) => ({ ...current, [fieldId]: selected }));
            // A blank rate means the retailer has not decided yet; the
            // catalogue price is the sensible start.
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

        {/* Warns before submitting rather than failing at the server: the
            invoice will be refused, and finding that out now is cheaper. */}
        {shortages.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive-muted px-4 py-3 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">Not enough stock to sell this</p>
              <ul className="mt-1 space-y-0.5">
                {shortages.map((shortage) => (
                  <li key={shortage}>{shortage}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
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
                  <Textarea
                    rows={3}
                    placeholder="Printed on the invoice"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <DocumentTotals totals={totals}>
            <p className="flex items-start gap-1.5 pt-1 text-xs leading-relaxed text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              Recalculated on the server when you save. Posting also moves the
              stock and writes the journal entry.
            </p>

            <Button
              type="submit"
              className="mt-2 w-full"
              loading={form.formState.isSubmitting}
              loadingText="Posting…"
              disabled={shortages.length > 0}
            >
              Post invoice
            </Button>
          </DocumentTotals>
        </div>
      </form>
    </Form>
  );
}
