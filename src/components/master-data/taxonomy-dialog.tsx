"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import { FormError } from "@/components/auth/form-error";
import { useServerFormErrors } from "@/components/auth/use-action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { AmountInput } from "@/components/ui/amount-input";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  categorySchema,
  unitSchema,
  type CategoryInput,
  type UnitInput,
} from "@/lib/validation/master-data";
import type { ActionResult } from "@/server/auth/action-result";
import type { ProductTaxonomy } from "@/server/master-data/taxonomy-service";
import {
  archiveCategoryAction,
  createCategoryAction,
  createUnitAction,
} from "@/server/master-data/actions";

/**
 * Categories and units.
 *
 * Both are small enough that a full page would be overkill, and both are needed
 * mid-flow while adding a product — so they live in a dialog reachable from the
 * product list rather than buried in settings.
 *
 * Tax rates are shown but not editable: they are versioned records, and letting
 * a product form rewrite the rate an old invoice was calculated at would make
 * that invoice impossible to reproduce.
 */
export function TaxonomyDialog({
  open,
  taxonomy,
  onClose,
}: {
  open: boolean;
  taxonomy: ProductTaxonomy;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Categories &amp; units</DialogTitle>
          <DialogDescription>
            How your products are grouped and how their quantities are counted.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="categories">
          <TabsList>
            <TabsTrigger value="categories">Categories</TabsTrigger>
            <TabsTrigger value="units">Units</TabsTrigger>
            <TabsTrigger value="tax">GST rates</TabsTrigger>
          </TabsList>

          <TabsContent value="categories" className="space-y-4 pt-4">
            <CategorySection categories={taxonomy.categories} />
          </TabsContent>

          <TabsContent value="units" className="space-y-4 pt-4">
            <UnitSection units={taxonomy.units} />
          </TabsContent>

          <TabsContent value="tax" className="space-y-3 pt-4">
            <ul className="divide-y overflow-hidden rounded-lg border">
              {taxonomy.taxRates.map((rate) => (
                <li
                  key={rate.id}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm"
                >
                  <span>{rate.name}</span>
                  <Badge variant="outline" className="font-mono">
                    {rate.code}
                  </Badge>
                </li>
              ))}
            </ul>
            <p className="text-xs leading-relaxed text-muted-foreground">
              GST slabs are set by the government, not by a business. A rate is
              never edited in place — a change is a new version with a later
              effective date, so historical invoices keep reproducing the tax
              that actually applied on their day.
            </p>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function CategorySection({
  categories,
}: {
  categories: ProductTaxonomy["categories"];
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [listError, setListError] = React.useState<string | null>(null);

  const form = useForm<CategoryInput>({
    resolver: zodResolver(categorySchema),
    defaultValues: { name: "", parentId: "", description: "" },
  });
  const { formError, applyResult } = useServerFormErrors(form);

  async function onSubmit(values: CategoryInput) {
    const result: ActionResult<unknown> = await createCategoryAction(values);
    if (!applyResult(result)) return;
    form.reset({ name: "", parentId: "", description: "" });
    router.refresh();
  }

  async function archive(id: string) {
    setListError(null);
    setPending(id);
    try {
      const result = await archiveCategoryAction(id);
      if (!result.ok) {
        setListError(result.message);
        return;
      }
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="flex items-start gap-2"
        >
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel className="sr-only">Category name</FormLabel>
                <FormControl>
                  <Input placeholder="Add a category" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" loading={form.formState.isSubmitting}>
            <Plus className="size-4" />
            Add
          </Button>
        </form>
      </Form>

      <FormError message={formError ?? listError} />

      {categories.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          No categories yet. They are optional — useful once you have enough
          products that a list stops being scannable.
        </p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {categories.map((category) => (
            <li
              key={category.id}
              className="flex items-center justify-between gap-3 px-3 py-2.5"
            >
              <span className="text-sm">
                {category.name}
                <span className="ml-2 text-xs text-muted-foreground">
                  {category.productCount}{" "}
                  {category.productCount === 1 ? "product" : "products"}
                </span>
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Archive ${category.name}`}
                loading={pending === category.id}
                onClick={() => archive(category.id)}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs leading-relaxed text-muted-foreground">
        Archiving a category leaves its products where they are — an old product
        can still say what it was filed under.
      </p>
    </>
  );
}

function UnitSection({ units }: { units: ProductTaxonomy["units"] }) {
  const router = useRouter();

  const form = useForm<UnitInput>({
    resolver: zodResolver(unitSchema),
    defaultValues: { code: "", name: "", precision: 0 },
  });
  const { formError, applyResult } = useServerFormErrors(form);

  async function onSubmit(values: UnitInput) {
    const result: ActionResult<unknown> = await createUnitAction(values);
    if (!applyResult(result)) return;
    form.reset({ code: "", name: "", precision: 0 });
    router.refresh();
  }

  return (
    <>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[6rem_1fr_7rem]">
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Code</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="KG"
                      maxLength={8}
                      className="uppercase"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Kilogram" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="precision"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Decimals</FormLabel>
                  <FormControl>
                    <AmountInput
                      name={field.name}
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      min={0}
                      max={3}
                      step="1"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          {/* Describes the row of fields rather than any single one, so it is
              a paragraph — FormDescription needs a field's context. */}
          <p className="text-sm leading-relaxed text-muted-foreground">
            Decimals decide what a quantity may be: 0 for pieces you cannot sell
            half of, 3 for weight. It cannot be changed once products use the
            unit — the figures would read differently without anything having
            actually converted.
          </p>
          <Button type="submit" loading={form.formState.isSubmitting}>
            <Plus className="size-4" />
            Add unit
          </Button>
        </form>
      </Form>

      <FormError message={formError} />

      <ul className="divide-y overflow-hidden rounded-lg border">
        {units.map((unit) => (
          <li
            key={unit.id}
            className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm"
          >
            <span>
              {unit.name}
              <Badge variant="outline" className="ml-2 font-mono text-[0.6875rem]">
                {unit.code}
              </Badge>
            </span>
            <span className="text-xs text-muted-foreground">
              {unit.precision === 0
                ? "whole numbers"
                : `${unit.precision} decimals`}
              {unit.productCount > 0 && ` · ${unit.productCount} in use`}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
