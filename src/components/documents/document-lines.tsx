"use client";

import * as React from "react";
import type {
  Control,
  FieldArrayWithId,
  FieldValues,
  Path,
  UseFormReturn,
} from "react-hook-form";
import { Plus, Trash2 } from "lucide-react";
import {
  ProductPicker,
  type PickerProduct,
} from "@/components/documents/product-picker";
import { AmountInput } from "@/components/ui/amount-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { formatCurrency } from "@/lib/format";
import type { GstLineResult } from "@/lib/tax/gst";

/**
 * The line editor an invoice and a bill share.
 *
 * Both documents ask the same four questions of every line — which product,
 * how many, at what rate, less what discount — and show the same running total.
 * Keeping one editor means a fix to how a discount reads, or how a line total
 * is announced, lands on both rather than on whichever was edited last.
 *
 * The surrounding form owns the schema, the totals and the wording; this owns
 * the rows.
 */

export type LinePath = `lines.${number}`;

export function DocumentLines<TValues extends FieldValues>({
  form,
  fields,
  computed,
  picked,
  onPick,
  onRemove,
  onAdd,
  search,
  warnWhenEmpty,
  showTax,
}: {
  form: UseFormReturn<TValues>;
  fields: FieldArrayWithId<TValues>[];
  /** Per-line tax result, already computed by the caller. */
  computed: GstLineResult[];
  picked: Record<string, PickerProduct>;
  onPick: (fieldId: string, index: number, product: PickerProduct) => void;
  onRemove: (fieldId: string, index: number) => void;
  onAdd: () => void;
  search: (query: string) => Promise<PickerProduct[]>;
  warnWhenEmpty?: boolean;
  showTax: boolean;
}) {
  const control = form.control as Control<TValues>;

  return (
    <div className="space-y-3">
      {fields.map((field, index) => {
        const product = picked[field.id];
        const line = computed[index];
        const first = index === 0;

        return (
          <Card key={field.id}>
            <CardContent className="grid gap-4 py-5 lg:grid-cols-[minmax(0,2fr)_6rem_8rem_6rem_auto]">
              <FormField
                control={control}
                name={`lines.${index}.productId` as Path<TValues>}
                render={({ field: productField }) => (
                  <FormItem>
                    <FormLabel className={first ? undefined : "lg:sr-only"}>
                      Item
                    </FormLabel>
                    <FormControl>
                      <ProductPicker
                        value={product ?? null}
                        search={search}
                        warnWhenEmpty={warnWhenEmpty}
                        onSelect={(selected) => {
                          onPick(field.id, index, selected);
                          productField.onChange(selected.id);
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

              <NumberCell
                control={control}
                name={`lines.${index}.quantity` as Path<TValues>}
                label="Qty"
                srOnly={!first}
                step="0.001"
              />

              <NumberCell
                control={control}
                name={`lines.${index}.rate` as Path<TValues>}
                label="Rate"
                srOnly={!first}
                step="0.01"
                prefix="₹"
              />

              <NumberCell
                control={control}
                name={`lines.${index}.discountPercent` as Path<TValues>}
                label="Disc %"
                srOnly={!first}
                step="0.1"
                max={100}
              />

              <div className="flex items-end justify-between gap-3 lg:flex-col lg:items-end">
                <div className="text-right">
                  <p className="text-muted-foreground text-xs lg:hidden">
                    Line total
                  </p>
                  <p className="tabular-figures font-medium">
                    {formatCurrency(line?.lineTotal.toFixed(4) ?? 0)}
                  </p>
                  {showTax && line && !line.taxableAmount.isZero() && (
                    <p className="text-muted-foreground tabular-figures text-xs">
                      {formatCurrency(line.taxableAmount.toFixed(4))} + tax
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove line ${index + 1}`}
                  disabled={fields.length === 1}
                  onClick={() => onRemove(field.id, index)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}

      <Button type="button" variant="outline" onClick={onAdd}>
        <Plus className="size-4" />
        Add line
      </Button>
    </div>
  );
}

function NumberCell<TValues extends FieldValues>({
  control,
  name,
  label,
  srOnly,
  step,
  max,
  prefix,
}: {
  control: Control<TValues>;
  name: Path<TValues>;
  label: string;
  srOnly: boolean;
  step: string;
  max?: number;
  prefix?: string;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel className={srOnly ? "lg:sr-only" : undefined}>
            {label}
          </FormLabel>
          <FormControl>
            <AmountInput
              prefix={prefix}
              name={field.name}
              value={field.value as number}
              onChange={field.onChange}
              onBlur={field.onBlur}
              min={0}
              max={max}
              step={step}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** The totals panel both documents show, in the order an accountant reads it. */
export function DocumentTotals({
  totals,
  extra,
  children,
}: {
  totals: {
    taxableAmount: { isZero: () => boolean; toFixed: (n: number) => string };
    discountAmount: { isZero: () => boolean; toFixed: (n: number) => string };
    cgstAmount: { isZero: () => boolean; toFixed: (n: number) => string };
    sgstAmount: { isZero: () => boolean; toFixed: (n: number) => string };
    igstAmount: { isZero: () => boolean; toFixed: (n: number) => string };
    roundOff: { isZero: () => boolean; toFixed: (n: number) => string };
    totalAmount: { toFixed: (n: number) => string };
  };
  /** Rows a particular document adds, such as input credit on a bill. */
  extra?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="space-y-2 py-5 text-sm">
        <TotalRow label="Taxable value" value={totals.taxableAmount} />
        {!totals.discountAmount.isZero() && (
          <TotalRow label="Discount" value={totals.discountAmount} muted />
        )}
        {!totals.cgstAmount.isZero() && (
          <TotalRow label="CGST" value={totals.cgstAmount} muted />
        )}
        {!totals.sgstAmount.isZero() && (
          <TotalRow label="SGST" value={totals.sgstAmount} muted />
        )}
        {!totals.igstAmount.isZero() && (
          <TotalRow label="IGST" value={totals.igstAmount} muted />
        )}
        {!totals.roundOff.isZero() && (
          <TotalRow label="Round off" value={totals.roundOff} muted />
        )}

        <div className="flex items-baseline justify-between border-t pt-3">
          <span className="font-medium">Total</span>
          <span className="tabular-figures text-lg font-semibold">
            {formatCurrency(totals.totalAmount.toFixed(4))}
          </span>
        </div>

        {extra}
        {children}
      </CardContent>
    </Card>
  );
}

function TotalRow({
  label,
  value,
  muted,
}: {
  label: string;
  value: { toFixed: (n: number) => string };
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className={muted ? "text-muted-foreground" : undefined}>{label}</span>
      <span className="tabular-figures">{formatCurrency(value.toFixed(4))}</span>
    </div>
  );
}
