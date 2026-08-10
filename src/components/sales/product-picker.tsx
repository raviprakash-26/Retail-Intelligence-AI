"use client";

import * as React from "react";
import { Check, ChevronsUpDown, Loader2, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatCurrency, formatNumber } from "@/lib/format";
import type { SellableProduct } from "@/server/sales/actions";
import { searchSellableProductsAction } from "@/server/sales/actions";
import { cn } from "@/lib/utils";

/**
 * Picks a product for an invoice line.
 *
 * Search runs on the server. Preloading the catalogue would make typing feel
 * faster and would also hand every cashier the tenant's entire product list,
 * stock position included, on page load.
 *
 * Stock is shown next to each product because the invoice will refuse to sell
 * what is not there — finding that out while choosing is much better than
 * finding out at submit.
 */
export function ProductPicker({
  value,
  onSelect,
  disabled,
}: {
  value: SellableProduct | null;
  onSelect: (product: SellableProduct) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SellableProduct[]>([]);
  const [loading, setLoading] = React.useState(false);
  const requestId = React.useRef(0);
  const debounce = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, []);

  const runSearch = React.useCallback((term: string) => {
    if (debounce.current) clearTimeout(debounce.current);
    setLoading(true);
    const id = ++requestId.current;
    debounce.current = setTimeout(async () => {
      try {
        const found = await searchSellableProductsAction(term);
        // A slow early query must not overwrite a later, faster one.
        if (id !== requestId.current) return;
        setResults(found);
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, 180);
  }, []);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next && results.length === 0) runSearch("");
  }

  function onQueryChange(next: string) {
    setQuery(next);
    runSearch(next);
  }

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            "h-10 w-full justify-between gap-2 px-3 font-normal",
            !value && "text-muted-foreground",
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            {value ? (
              <span className="truncate">{value.name}</span>
            ) : (
              <>
                <Search className="size-4 shrink-0" />
                <span>Choose a product</span>
              </>
            )}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        className="w-[min(28rem,calc(100vw-2rem))] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search by name, code or barcode…"
            value={query}
            onValueChange={onQueryChange}
          />
          <CommandList>
            {loading && (
              <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
                <Loader2 className="size-4 animate-spin" />
                Searching…
              </div>
            )}

            {!loading && results.length === 0 && (
              <CommandEmpty>
                Nothing matched. Add the product first, then invoice it.
              </CommandEmpty>
            )}

            {!loading &&
              results.map((product) => {
                const outOfStock =
                  product.isStockTracked && Number(product.stockOnHand) <= 0;
                return (
                  <CommandItem
                    key={product.id}
                    value={product.id}
                    onSelect={() => {
                      onSelect(product);
                      setOpen(false);
                    }}
                    className="gap-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                        {product.name}
                        {value?.id === product.id && (
                          <Check className="text-primary size-3.5" />
                        )}
                      </p>
                      <p className="text-muted-foreground truncate font-mono text-xs">
                        {product.sku}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm tabular-figures">
                        {formatCurrency(product.sellingPrice, {
                          compactZeroDecimals: true,
                        })}
                      </p>
                      {product.isStockTracked ? (
                        <Badge
                          variant={outOfStock ? "danger" : "muted"}
                          className="mt-0.5 text-[0.625rem]"
                        >
                          {formatNumber(product.stockOnHand ?? 0)}{" "}
                          {product.unitCode}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="mt-0.5 text-[0.625rem]">
                          Service
                        </Badge>
                      )}
                    </div>
                  </CommandItem>
                );
              })}
          </CommandList>
        </Command>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
