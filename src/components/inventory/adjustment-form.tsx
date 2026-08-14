"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowDown, ArrowUp, Info } from "lucide-react";
import { FormError } from "@/components/auth/form-error";
import { useServerFormErrors } from "@/components/auth/use-action-form";
import { AmountInput } from "@/components/ui/amount-input";
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
import { formatCurrency, formatNumber } from "@/lib/format";
import {
  ADJUSTMENT_REASONS,
  ADJUSTMENT_REASON_LABELS,
  stockAdjustmentSchema,
  type StockAdjustmentInput,
} from "@/lib/validation/inventory";
import { cn } from "@/lib/utils";
import {
  bookQuantityAction,
  createStockAdjustmentAction,
} from "@/server/inventory/actions";

/**
 * Correcting what the books say is on the shelf.
 *
 * The form asks for what was counted, not for the difference. A retailer counts
 * the shelf; asking them to work out and sign a delta invites a sign error
 * nobody notices until the stock figure is meaningless. So the books' figure is
 * fetched and shown beside the box, and the consequence — how much goes in or
 * out, and what it is worth — is spelled out before anything is posted.
 */
export function AdjustmentForm({
  products,
}: {
  products: Array<{ id: string; sku: string; name: string; unitCode: string }>;
}) {
  const router = useRouter();

  const form = useForm<StockAdjustmentInput>({
    resolver: zodResolver(stockAdjustmentSchema),
    defaultValues: {
      productId: "",
      adjustmentDate: new Date().toISOString().slice(0, 10),
      reason: "COUNT",
      countedQuantity: 0,
      notes: "",
    },
  });

  const { formError, applyResult } = useServerFormErrors(form);
  const productId = form.watch("productId");
  const counted = form.watch("countedQuantity");
  const reason = form.watch("reason");

  const [books, setBooks] = React.useState<{
    quantity: string;
    averageCost: string;
    stockValue: string;
  } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const requestId = React.useRef(0);

  const product = products.find((entry) => entry.id === productId) ?? null;

  async function onProductChange(next: string) {
    form.setValue("productId", next);
    setBooks(null);
    if (!next) return;

    setLoading(true);
    const id = ++requestId.current;
    try {
      const position = await bookQuantityAction(next);
      if (id !== requestId.current) return;
      setBooks(position);
      form.setValue("countedQuantity", Number(position.quantity));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }

  const bookQuantity = books ? Number(books.quantity) : null;
  const difference = bookQuantity === null ? null : counted - bookQuantity;
  const averageCost = books ? Number(books.averageCost) : 0;

  async function onSubmit(values: StockAdjustmentInput) {
    const result = await createStockAdjustmentAction(values);
    if (!applyResult(result)) return;
    router.push(`/app/inventory/${values.productId}`);
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <FormError message={formError} />

        <Card>
          <CardContent className="grid gap-5 py-6 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="productId"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Which product?</FormLabel>
                  <Select onValueChange={onProductChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a product" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {products.map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.name} · {entry.sku}
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
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>What happened?</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {ADJUSTMENT_REASONS.map((value) => (
                        <SelectItem key={value} value={value}>
                          {ADJUSTMENT_REASON_LABELS[value].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {ADJUSTMENT_REASON_LABELS[reason].hint}
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="adjustmentDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>When</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="countedQuantity"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    What did you count?
                    {product && (
                      <span className="font-normal text-muted-foreground">
                        in {product.unitCode}
                      </span>
                    )}
                  </FormLabel>
                  <FormControl>
                    <AmountInput
                      name={field.name}
                      value={field.value}
                      onChange={field.onChange}
                      disabled={!productId || loading}
                    />
                  </FormControl>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {loading
                      ? "Reading what the books say…"
                      : bookQuantity === null
                        ? "Choose a product first."
                        : `The books say ${formatNumber(books!.quantity)}${product ? ` ${product.unitCode}` : ""}.`}
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Why does it differ?</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={2}
                      placeholder="A carton was crushed in the storeroom"
                      {...field}
                    />
                  </FormControl>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Required. Stock that vanishes without an explanation is the
                    hardest thing to investigate six months later.
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {difference !== null && difference !== 0 && (
          <div className="rounded-xl border px-5 py-4">
            <p
              className={cn(
                "flex items-center gap-2 text-sm font-medium",
                difference < 0 ? "text-destructive" : "text-success-foreground",
              )}
            >
              {difference < 0 ? (
                <ArrowDown className="size-4" />
              ) : (
                <ArrowUp className="size-4" />
              )}
              {formatNumber(Math.abs(difference))}
              {product ? ` ${product.unitCode}` : ""}{" "}
              {difference < 0 ? "will come out of stock" : "will go into stock"}
            </p>
            <p className="mt-1.5 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Worth about {formatCurrency(Math.abs(difference) * averageCost)}{" "}
                at the {formatCurrency(averageCost)} average cost.{" "}
                {difference < 0
                  ? "That value becomes a cost the moment this is recorded — goods you paid for and will not sell."
                  : "It is added back to stock and taken off the loss account, not counted as income: nobody bought anything."}
              </span>
            </p>
          </div>
        )}

        <div className="flex items-center justify-end gap-3">
          <Button
            type="submit"
            disabled={!productId || difference === 0 || difference === null}
            loading={form.formState.isSubmitting}
            loadingText="Recording…"
          >
            Record the correction
          </Button>
        </div>
      </form>
    </Form>
  );
}
