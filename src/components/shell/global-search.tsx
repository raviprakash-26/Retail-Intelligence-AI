"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import {
  BookOpenCheck,
  Loader2,
  Package,
  Search,
  Truck,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { globalSearchAction } from "@/server/search/actions";
import type { SearchResult, SearchResultKind } from "@/server/search/global-search";
import { cn } from "@/lib/utils";

const KIND_META: Record<SearchResultKind, { label: string; icon: typeof Users }> = {
  customer: { label: "Customers", icon: Users },
  supplier: { label: "Suppliers", icon: Truck },
  product: { label: "Products", icon: Package },
  account: { label: "Ledger accounts", icon: BookOpenCheck },
  page: { label: "Pages", icon: Search },
};

const ORDER: SearchResultKind[] = ["customer", "supplier", "product", "account"];

/**
 * Search is one dialog with any number of triggers.
 *
 * The top bar shows a trigger inline on desktop and again on its own row on
 * narrow screens. Rendering the whole component twice would mount two dialogs,
 * two ⌘K listeners and two inputs sharing a role — so the dialog lives in a
 * provider and the buttons are separate.
 */
const SearchContext = React.createContext<{ open: () => void } | null>(null);

export function GlobalSearchProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SearchResult[]>([]);
  const [loading, setLoading] = React.useState(false);
  const requestId = React.useRef(0);
  const debounce = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((previous) => !previous);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  React.useEffect(() => {
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, []);

  function reset() {
    if (debounce.current) clearTimeout(debounce.current);
    requestId.current += 1;
    setQuery("");
    setResults([]);
    setLoading(false);
  }

  function onQueryChange(next: string) {
    setQuery(next);
    if (debounce.current) clearTimeout(debounce.current);

    const trimmed = next.trim();
    if (trimmed.length < 2) {
      // Bumping the id abandons any request already in flight, so its result
      // cannot land after the field has been cleared.
      requestId.current += 1;
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const id = ++requestId.current;
    debounce.current = setTimeout(async () => {
      try {
        const found = await globalSearchAction(trimmed);
        // Discard a response that is no longer the newest request — otherwise
        // a slow early query can overwrite a later, faster one.
        if (id !== requestId.current) return;
        setResults(found);
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, 200);
  }

  function go(href: string) {
    setOpen(false);
    reset();
    router.push(href as Route);
  }

  const value = React.useMemo(() => ({ open: () => setOpen(true) }), []);

  const grouped = ORDER.map((kind) => ({
    kind,
    items: results.filter((result) => result.kind === kind),
  })).filter((group) => group.items.length > 0);

  const showEmptyPrompt = !loading && query.trim().length < 2;
  const showNoMatches = !loading && query.trim().length >= 2 && grouped.length === 0;

  return (
    <SearchContext.Provider value={value}>
      {children}

      <CommandDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        title="Search"
        description="Find customers, suppliers, products and ledger accounts"
        // Filtering happens on the server; cmdk must not filter again, or it
        // would hide results whose match was on a field we do not display.
        shouldFilter={false}
      >
        <CommandInput
          placeholder="Search customers, suppliers, products, accounts…"
          value={query}
          onValueChange={onQueryChange}
        />
        <CommandList>
          {loading && (
            <div className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-sm">
              <Loader2 className="size-4 animate-spin" />
              Searching…
            </div>
          )}

          {showEmptyPrompt && (
            <div className="text-muted-foreground px-3 py-8 text-center text-sm">
              Type at least two characters to search.
            </div>
          )}

          {showNoMatches && (
            <CommandEmpty>Nothing matched &ldquo;{query.trim()}&rdquo;.</CommandEmpty>
          )}

          {!loading &&
            grouped.map((group) => {
              const meta = KIND_META[group.kind];
              return (
                <CommandGroup key={group.kind} heading={meta.label}>
                  {group.items.map((result) => (
                    <CommandItem
                      key={`${result.kind}-${result.id}`}
                      value={`${result.kind}-${result.id}`}
                      onSelect={() => go(result.href)}
                      className="gap-2.5"
                    >
                      <meta.icon className="text-muted-foreground size-4" />
                      <span className="truncate">{result.title}</span>
                      {result.subtitle && (
                        <span className="text-muted-foreground ml-auto truncate text-xs">
                          {result.subtitle}
                        </span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}

          {/* Says plainly what is not searchable yet, rather than letting
              someone conclude their invoices have gone missing. */}
          {!loading && query.trim().length >= 2 && (
            <p className="text-muted-foreground border-t px-3 py-2.5 text-xs">
              Invoices, bills and journal entries become searchable as those
              modules are built.
            </p>
          )}
        </CommandList>
      </CommandDialog>
    </SearchContext.Provider>
  );
}

export function GlobalSearchTrigger({ className }: { className?: string }) {
  const context = React.useContext(SearchContext);
  // Loud rather than quiet: a trigger outside the provider would render a
  // button that looks fine and does nothing at all.
  if (!context) {
    throw new Error("GlobalSearchTrigger must be rendered inside GlobalSearchProvider");
  }

  return (
    <Button
      variant="outline"
      onClick={context.open}
      className={cn(
        "text-muted-foreground h-9 w-full justify-start gap-2 px-3 font-normal",
        className,
      )}
    >
      <Search className="size-4" />
      <span className="truncate">Search…</span>
      <kbd className="bg-muted ml-auto hidden rounded border px-1.5 py-0.5 font-mono text-[0.625rem] sm:inline-block">
        ⌘K
      </kbd>
    </Button>
  );
}
