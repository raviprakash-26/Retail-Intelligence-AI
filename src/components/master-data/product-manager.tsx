"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArchiveRestore,
  EllipsisVertical,
  Info,
  Plus,
  TriangleAlert,
} from "lucide-react";
import { FormError } from "@/components/auth/form-error";
import { useServerFormErrors } from "@/components/auth/use-action-form";
import {
  ListPagination,
  ListToolbar,
} from "@/components/master-data/list-toolbar";
import { announceDeferredOpening } from "@/components/master-data/opening-balance-fields";
import { TaxonomyDialog } from "@/components/master-data/taxonomy-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { AmountInput } from "@/components/ui/amount-input";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency, formatNumber } from "@/lib/format";
import {
  marginWarning,
  productSchema,
  type ProductInput,
} from "@/lib/validation/master-data";
import type { ActionResult } from "@/server/auth/action-result";
import type { ProductRow } from "@/server/master-data/product-service";
import type { ProductTaxonomy } from "@/server/master-data/taxonomy-service";
import {
  createProductAction,
  setProductArchivedAction,
  updateProductAction,
} from "@/server/master-data/actions";

/**
 * Products and services.
 *
 * The form is split into what a product *is*, what it *costs and sells for*,
 * and what stock it *starts with* — because only the last of those touches the
 * ledger, and it should be obvious which part does.
 */

const NO_SELECTION = "__none";

function emptyValues(defaultUnitId: string): ProductInput {
  return {
    sku: "",
    name: "",
    description: "",
    barcode: "",
    hsnCode: "",
    categoryId: "",
    unitId: defaultUnitId,
    taxRateId: "",
    purchasePrice: 0,
    sellingPrice: 0,
    mrp: 0,
    isStockTracked: true,
    openingQuantity: 0,
    openingRate: 0,
    minStockLevel: 0,
  };
}

export function ProductManager({
  result,
  taxonomy,
  canManage,
}: {
  result: {
    rows: ProductRow[];
    total: number;
    page: number;
    pageCount: number;
  };
  taxonomy: ProductTaxonomy;
  canManage: boolean;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<string | null>(null);
  const [taxonomyOpen, setTaxonomyOpen] = React.useState(false);
  const [dialog, setDialog] = React.useState<
    { mode: "create" } | { mode: "edit"; product: ProductRow } | null
  >(null);

  async function run(
    id: string,
    operation: () => Promise<ActionResult<unknown>>,
  ) {
    setError(null);
    setPending(id);
    try {
      const outcome = await operation();
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  const noUnits = taxonomy.units.length === 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ListToolbar
          searchPlaceholder="Search by name, code or barcode"
          filterLabel="All categories"
          filterOptions={taxonomy.categories.map((category) => ({
            value: category.id,
            label: category.name,
          }))}
          archivedLabel="Show archived"
        />
        <div className="flex gap-2">
          {canManage && (
            <Button variant="outline" onClick={() => setTaxonomyOpen(true)}>
              Categories &amp; units
            </Button>
          )}
          {canManage && (
            <Button
              onClick={() => setDialog({ mode: "create" })}
              disabled={noUnits}
            >
              <Plus className="size-4" />
              Add product
            </Button>
          )}
        </div>
      </div>

      <FormError message={error} />

      {result.rows.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <h2 className="text-base font-semibold">Nothing here yet</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            Add what you sell. Each product carries its own GST rate and HSN
            code, so an invoice works out its own tax rather than asking you to.
          </p>
          {canManage && (
            <Button
              className="mt-5"
              onClick={() => setDialog({ mode: "create" })}
            >
              <Plus className="size-4" />
              Add product
            </Button>
          )}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>HSN / GST</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">In stock</TableHead>
              {canManage && <TableHead className="w-12" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.map((product) => (
              <TableRow
                key={product.id}
                data-state={product.isArchived ? "archived" : undefined}
              >
                <TableCell>
                  <p className="flex flex-wrap items-center gap-1.5 font-medium">
                    {product.name}
                    {product.isArchived && (
                      <Badge variant="muted">Archived</Badge>
                    )}
                    {!product.isStockTracked && (
                      <Badge variant="outline">Service</Badge>
                    )}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {product.sku}
                  </p>
                </TableCell>
                <TableCell className="text-sm">
                  {product.categoryName ?? (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-sm">
                  <span className="font-mono text-xs">
                    {product.hsnCode ?? "—"}
                  </span>
                  {product.taxRateLabel && (
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {product.taxRateLabel}
                    </span>
                  )}
                </TableCell>
                <TableCell className="tabular-figures text-right">
                  {formatCurrency(product.purchasePrice, {
                    compactZeroDecimals: true,
                  })}
                </TableCell>
                <TableCell className="tabular-figures text-right">
                  {formatCurrency(product.sellingPrice, {
                    compactZeroDecimals: true,
                  })}
                </TableCell>
                <TableCell className="tabular-figures text-right">
                  {product.stockOnHand === null ? (
                    <span className="text-muted-foreground">n/a</span>
                  ) : (
                    <>
                      <span
                        className={
                          Number(product.stockOnHand) <=
                            Number(product.minStockLevel) &&
                          Number(product.minStockLevel) > 0
                            ? "text-destructive"
                            : undefined
                        }
                      >
                        {formatNumber(product.stockOnHand)}
                      </span>
                      <span className="ml-1 text-xs text-muted-foreground">
                        {product.unitCode}
                      </span>
                    </>
                  )}
                </TableCell>
                {canManage && (
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Manage ${product.name}`}
                          loading={pending === product.id}
                        >
                          <EllipsisVertical className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => setDialog({ mode: "edit", product })}
                        >
                          Edit details
                        </DropdownMenuItem>
                        {product.isArchived ? (
                          <DropdownMenuItem
                            onClick={() =>
                              run(product.id, () =>
                                setProductArchivedAction(product.id, false),
                              )
                            }
                          >
                            <ArchiveRestore className="size-4" />
                            Restore
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() =>
                              run(product.id, () =>
                                setProductArchivedAction(product.id, true),
                              )
                            }
                          >
                            Archive
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <ListPagination
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        noun="product"
      />

      <ProductDialog
        state={dialog}
        taxonomy={taxonomy}
        onClose={() => setDialog(null)}
        onSaved={() => {
          setDialog(null);
          router.refresh();
        }}
      />

      <TaxonomyDialog
        open={taxonomyOpen}
        taxonomy={taxonomy}
        onClose={() => setTaxonomyOpen(false)}
      />
    </div>
  );
}

function ProductDialog({
  state,
  taxonomy,
  onClose,
  onSaved,
}: {
  state: { mode: "create" } | { mode: "edit"; product: ProductRow } | null;
  taxonomy: ProductTaxonomy;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = state?.mode === "edit" ? state.product : null;
  const defaultUnitId = taxonomy.units[0]?.id ?? "";

  const form = useForm<ProductInput>({
    resolver: zodResolver(productSchema),
    defaultValues: emptyValues(defaultUnitId),
  });

  const { formError, applyResult, reset } = useServerFormErrors(form);

  const key = editing?.id ?? state?.mode ?? null;
  const [lastKey, setLastKey] = React.useState<string | null>(null);
  if (key !== lastKey) {
    setLastKey(key);
    form.reset(
      editing
        ? {
            sku: editing.sku,
            name: editing.name,
            description: editing.description ?? "",
            barcode: editing.barcode ?? "",
            hsnCode: editing.hsnCode ?? "",
            categoryId: editing.categoryId ?? "",
            unitId: editing.unitId,
            taxRateId: editing.taxRateId ?? "",
            purchasePrice: Number(editing.purchasePrice),
            sellingPrice: Number(editing.sellingPrice),
            mrp: Number(editing.mrp),
            isStockTracked: editing.isStockTracked,
            openingQuantity: Number(editing.openingQuantity),
            openingRate: Number(editing.openingRate),
            minStockLevel: Number(editing.minStockLevel),
          }
        : emptyValues(defaultUnitId),
    );
    reset();
  }

  const isStockTracked = form.watch("isStockTracked");
  const openingQuantity = form.watch("openingQuantity");
  const openingRate = form.watch("openingRate");
  const purchasePrice = form.watch("purchasePrice");
  const sellingPrice = form.watch("sellingPrice");

  const margin = marginWarning({ purchasePrice, sellingPrice });
  const openingValue = (openingQuantity || 0) * (openingRate || 0);

  async function onSubmit(values: ProductInput) {
    // Kept apart rather than merged into one `result`: only creating a product
    // carries opening stock, so only that result can report the opening entry
    // having been dated forward.
    if (editing) {
      const result = await updateProductAction(editing.id, values);
      if (!applyResult(result as ActionResult<unknown>)) return;
    } else {
      const result = await createProductAction(values);
      if (!applyResult(result as ActionResult<unknown>)) return;
      if (result.ok) {
        announceDeferredOpening(result.data.openingDeferredTo, values.name);
      }
    }
    onSaved();
  }

  return (
    <Dialog open={Boolean(state)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit product" : "Add a product"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "Prices and details apply to documents raised from now on. Anything already invoiced keeps the figures it was raised with."
              : "What you sell, what it costs you, and what you have on the shelf today."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <FormError message={formError} />

            <section className="space-y-5">
              <div className="grid gap-5 sm:grid-cols-[10rem_1fr]">
                <FormField
                  control={form.control}
                  name="sku"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Product code</FormLabel>
                      <FormControl>
                        <Input
                          maxLength={40}
                          className="font-mono uppercase"
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
                        <Input autoFocus {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid gap-5 sm:grid-cols-3">
                <FormField
                  control={form.control}
                  name="categoryId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Category
                        <span className="font-normal text-muted-foreground">
                          (optional)
                        </span>
                      </FormLabel>
                      <Select
                        onValueChange={(value) =>
                          field.onChange(value === NO_SELECTION ? "" : value)
                        }
                        value={field.value || NO_SELECTION}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value={NO_SELECTION}>
                            Uncategorised
                          </SelectItem>
                          {taxonomy.categories.map((category) => (
                            <SelectItem key={category.id} value={category.id}>
                              {category.name}
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
                  name="unitId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sold in</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Choose" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="max-h-72">
                          {taxonomy.units.map((unit) => (
                            <SelectItem key={unit.id} value={unit.id}>
                              {unit.name} ({unit.code})
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
                  name="barcode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Barcode
                        <span className="font-normal text-muted-foreground">
                          (optional)
                        </span>
                      </FormLabel>
                      <FormControl>
                        <Input className="font-mono" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="hsnCode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        HSN / SAC
                        <span className="font-normal text-muted-foreground">
                          (optional)
                        </span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          inputMode="numeric"
                          maxLength={8}
                          className="font-mono"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        Printed on GST invoices and used to group your outward
                        supplies in GSTR-1.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="taxRateId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>GST rate</FormLabel>
                      <Select
                        onValueChange={(value) =>
                          field.onChange(value === NO_SELECTION ? "" : value)
                        }
                        value={field.value || NO_SELECTION}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value={NO_SELECTION}>Not set</SelectItem>
                          {taxonomy.taxRates.map((rate) => (
                            <SelectItem key={rate.id} value={rate.id}>
                              {rate.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        Applied automatically when this product is invoiced.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </section>

            <section className="space-y-5 border-t pt-5">
              <div className="grid gap-5 sm:grid-cols-3">
                <FormField
                  control={form.control}
                  name="purchasePrice"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Purchase price</FormLabel>
                      <FormControl>
                        <AmountInput
                          prefix="₹"
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
                  name="sellingPrice"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Selling price</FormLabel>
                      <FormControl>
                        <AmountInput
                          prefix="₹"
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
                  name="mrp"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        MRP
                        <span className="font-normal text-muted-foreground">
                          (optional)
                        </span>
                      </FormLabel>
                      <FormControl>
                        <AmountInput
                          prefix="₹"
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
              </div>

              {/* A loss-leader is a real decision, so this informs rather than
                  blocks. */}
              {margin && (
                <p className="flex items-start gap-2 text-sm text-warning-foreground">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                  {margin}
                </p>
              )}
            </section>

            <section className="space-y-5 border-t pt-5">
              <FormField
                control={form.control}
                name="isStockTracked"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start gap-3">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        disabled={Boolean(editing)}
                      />
                    </FormControl>
                    <div className="space-y-1">
                      <FormLabel className="font-normal">
                        Track stock for this item
                      </FormLabel>
                      <FormDescription>
                        Turn off for services and charges — delivery, repairs,
                        installation. They have no stock ledger and never appear
                        in a stock valuation.
                      </FormDescription>
                    </div>
                  </FormItem>
                )}
              />

              {isStockTracked && (
                <div className="grid gap-5 sm:grid-cols-3">
                  <FormField
                    control={form.control}
                    name="openingQuantity"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Opening stock</FormLabel>
                        <FormControl>
                          <AmountInput
                            name={field.name}
                            value={field.value}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            disabled={Boolean(editing)}
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
                    name="openingRate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Cost per unit</FormLabel>
                        <FormControl>
                          <AmountInput
                            prefix="₹"
                            name={field.name}
                            value={field.value}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            disabled={Boolean(editing)}
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
                    name="minStockLevel"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Reorder level</FormLabel>
                        <FormControl>
                          <AmountInput
                            name={field.name}
                            value={field.value}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            min={0}
                            step="0.001"
                          />
                        </FormControl>
                        <FormDescription>0 for no alert.</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              )}

              {/* Opening stock is not a note on a product card: it is an asset
                  the balance sheet has to carry. */}
              {isStockTracked && !editing && openingValue > 0 && (
                <p className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-sm leading-relaxed">
                  <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>
                    {formatCurrency(openingValue)} of stock will be posted to
                    Inventory against owner&rsquo;s capital, dated the first day
                    of your financial year.
                  </span>
                </p>
              )}

              {isStockTracked && editing && (
                <p className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-sm leading-relaxed">
                  <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>
                    Opening stock is fixed once a product exists — it is a
                    quantity in the stock ledger and a value in the journal, and
                    the two have to stay in step. Correcting it is a stock
                    adjustment, which arrives with the Inventory module.
                  </span>
                </p>
              )}
            </section>

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Description
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

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={form.formState.isSubmitting}
                loadingText="Saving…"
              >
                {editing ? "Save changes" : "Add product"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
