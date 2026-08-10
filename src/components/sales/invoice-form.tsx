"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Info, Plus, Trash2, TriangleAlert } from "lucide-react";
import { FormError } from "@/components/auth/form-error";
import { useServerFormErrors } from "@/components/auth/use-action-form";
import { ProductPicker } from "@/components/sales/product-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { AmountInput } from "@/components/ui/amount-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency } from "@/lib/format";
import { findStateByCode } from "@/lib/constants/india";
import {
  chargesTax,
  computeLine,
  describeSupplyType,
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
import type { SellableProduct } from "@/server/sales/actions";
import { createSaleAction } from "@/server/sales/actions";

/**
 * The invoice form.
 *
 * Totals are shown live using the same tax engine the server posts with, so
 * what the retailer sees before saving is what the books will say afterwards.
 * The figures still travel nowhere: the action sends products, quantities,
 * rates and discounts, and the server recomputes everything. The preview is a
 * preview.
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
  return { productId: "", description: "", quantity: 1, rate: 0, discountPercent: 0 };
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
  const [picked, setPicked] = React.useState<Record<string, SellableProduct>>({});

  const watched = form.watch();
  const customer = customers.find((entry) => entry.id === watched.customerId);

  const placeOfSupply =
    watched.placeOfSupply || customer?.stateCode || company.stateCode || null;

  const supplyType = resolveSupplyType({
    registration: company.gstRegistration,
    sellerStateCode: company.stateCode,
    placeOfSupplyStateCode: placeOfSupply,
  });

  const taxNotice = describeSupplyType(supplyType, company.gstRegistration);

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

        {/* --- Header ------------------------------------------------------ */}
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

        {/* --- Where the supply happens ------------------------------------ */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border bg-muted/30 px-4 py-3 text-sm">
          <span className="flex items-center gap-2">
            <Badge variant={supplyType === "INTER_STATE" ? "info" : "muted"}>
              {supplyType === "INTRA_STATE"
                ? "CGST + SGST"
                : supplyType === "INTER_STATE"
                  ? "IGST"
                  : "No GST"}
            </Badge>
            <span className="text-muted-foreground">
              {chargesTax(supplyType)
                ? `Place of supply ${findStateByCode(placeOfSupply ?? "")?.name ?? "—"}${
                    company.stateName ? ` · you supply from ${company.stateName}` : ""
                  }`
                : (taxNotice ?? "")}
            </span>
          </span>

          <FormField
            control={form.control}
            name="priceIncludesTax"
            render={({ field }) => (
              <FormItem className="ml-auto flex flex-row items-center gap-2">
                <FormControl>
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    id="price-includes-tax"
                  />
                </FormControl>
                <Label htmlFor="price-includes-tax" className="font-normal">
                  Rates include GST
                </Label>
              </FormItem>
            )}
          />
        </div>

        {/* --- Lines ------------------------------------------------------- */}
        <div className="space-y-3">
          {fields.map((field, index) => {
            const product = picked[field.id];
            const line = computed[index];
            return (
              <Card key={field.id}>
                <CardContent className="grid gap-4 py-5 lg:grid-cols-[minmax(0,2fr)_6rem_8rem_6rem_auto]">
                  <FormField
                    control={form.control}
                    name={`lines.${index}.productId`}
                    render={({ field: productField }) => (
                      <FormItem>
                        <FormLabel className={index === 0 ? undefined : "lg:sr-only"}>
                          Item
                        </FormLabel>
                        <FormControl>
                          <ProductPicker
                            value={product ?? null}
                            onSelect={(selected) => {
                              setPicked((current) => ({
                                ...current,
                                [field.id]: selected,
                              }));
                              productField.onChange(selected.id);
                              // A blank rate means the retailer has not decided
                              // yet; the catalogue price is the sensible start.
                              if (!form.getValues(`lines.${index}.rate`)) {
                                form.setValue(
                                  `lines.${index}.rate`,
                                  Number(selected.sellingPrice),
                                );
                              }
                            }}
                          />
                        </FormControl>
                        {product && (
                          <p className="text-muted-foreground text-xs">
                            {product.sku}
                            {product.hsnCode ? ` · HSN ${product.hsnCode}` : ""}
                            {` · ${Number(product.taxPercent)}% GST`}
                          </p>
                        )}
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name={`lines.${index}.quantity`}
                    render={({ field: quantityField }) => (
                      <FormItem>
                        <FormLabel className={index === 0 ? undefined : "lg:sr-only"}>
                          Qty
                        </FormLabel>
                        <FormControl>
                          <AmountInput
                            name={quantityField.name}
                            value={quantityField.value}
                            onChange={quantityField.onChange}
                            onBlur={quantityField.onBlur}
                            min={0}
                            step="0.001"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name={`lines.${index}.rate`}
                    render={({ field: rateField }) => (
                      <FormItem>
                        <FormLabel className={index === 0 ? undefined : "lg:sr-only"}>
                          Rate
                        </FormLabel>
                        <FormControl>
                          <AmountInput
                            prefix="₹"
                            name={rateField.name}
                            value={rateField.value}
                            onChange={rateField.onChange}
                            onBlur={rateField.onBlur}
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
                    name={`lines.${index}.discountPercent`}
                    render={({ field: discountField }) => (
                      <FormItem>
                        <FormLabel className={index === 0 ? undefined : "lg:sr-only"}>
                          Disc %
                        </FormLabel>
                        <FormControl>
                          <AmountInput
                            name={discountField.name}
                            value={discountField.value}
                            onChange={discountField.onChange}
                            onBlur={discountField.onBlur}
                            min={0}
                            max={100}
                            step="0.1"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="flex items-end justify-between gap-3 lg:flex-col lg:items-end">
                    <div className="text-right">
                      <p className="text-muted-foreground text-xs lg:hidden">
                        Line total
                      </p>
                      <p className="tabular-figures font-medium">
                        {formatCurrency(line?.lineTotal ?? 0)}
                      </p>
                      {chargesTax(supplyType) && line && !line.taxableAmount.isZero() && (
                        <p className="text-muted-foreground text-xs tabular-figures">
                          {formatCurrency(line.taxableAmount)} + tax
                        </p>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove line ${index + 1}`}
                      disabled={fields.length === 1}
                      onClick={() => {
                        setPicked((current) => {
                          const next = { ...current };
                          delete next[field.id];
                          return next;
                        });
                        remove(index);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}

          <Button
            type="button"
            variant="outline"
            onClick={() => append(emptyLine())}
          >
            <Plus className="size-4" />
            Add line
          </Button>
        </div>

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

        {/* --- Totals ------------------------------------------------------ */}
        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <FormField
            control={form.control}
            name="notes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Notes
                  <span className="text-muted-foreground font-normal">
                    (optional)
                  </span>
                </FormLabel>
                <FormControl>
                  <Textarea rows={3} placeholder="Printed on the invoice" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <Card>
            <CardContent className="space-y-2 py-5 text-sm">
              <Row label="Taxable value" value={totals.taxableAmount} />
              {!totals.discountAmount.isZero() && (
                <Row label="Discount" value={totals.discountAmount} muted />
              )}
              {!totals.cgstAmount.isZero() && (
                <Row label="CGST" value={totals.cgstAmount} muted />
              )}
              {!totals.sgstAmount.isZero() && (
                <Row label="SGST" value={totals.sgstAmount} muted />
              )}
              {!totals.igstAmount.isZero() && (
                <Row label="IGST" value={totals.igstAmount} muted />
              )}
              {!totals.roundOff.isZero() && (
                <Row label="Round off" value={totals.roundOff} muted />
              )}

              <div className="flex items-baseline justify-between border-t pt-3">
                <span className="font-medium">Total</span>
                <span className="text-lg font-semibold tabular-figures">
                  {formatCurrency(totals.totalAmount)}
                </span>
              </div>

              <p className="text-muted-foreground flex items-start gap-1.5 pt-1 text-xs leading-relaxed">
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
            </CardContent>
          </Card>
        </div>
      </form>
    </Form>
  );
}

function Row({
  label,
  value,
  muted,
}: {
  label: string;
  value: { toFixed: (places: number) => string };
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className={muted ? "text-muted-foreground" : undefined}>{label}</span>
      <span className="tabular-figures">{formatCurrency(value.toFixed(4))}</span>
    </div>
  );
}
