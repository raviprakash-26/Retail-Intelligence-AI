"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Search and filters for a master-data list.
 *
 * State lives in the URL rather than in the component, so a filtered list can
 * be bookmarked, shared and reloaded, and the back button behaves the way the
 * user expects. The server reads the same parameters and does the filtering —
 * which also means the browser never holds a full copy of the tenant's records
 * just to narrow them down.
 */

export type FilterOption = { value: string; label: string };

export function ListToolbar({
  searchPlaceholder,
  filterLabel,
  filterOptions,
  archivedLabel,
  hideArchived = false,
}: {
  searchPlaceholder: string;
  filterLabel?: string;
  filterOptions?: FilterOption[];
  /** Wording for the include-inactive checkbox, e.g. "Show archived". */
  archivedLabel: string;
  /** For lists where nothing is archived — transactions are voided, not hidden. */
  hideArchived?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const currentQuery = searchParams.get("q") ?? "";
  const currentFilter = searchParams.get("filter") ?? "";
  const showArchived = searchParams.get("archived") === "1";

  const [draft, setDraft] = React.useState(currentQuery);
  const debounce = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, []);

  const apply = React.useCallback(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      // Any filter change invalidates the page number: page 4 of a narrower
      // result set is usually empty, which reads as "nothing matched".
      next.delete("page");
      const query = next.toString();
      router.replace((query ? `${pathname}?${query}` : pathname) as Route);
    },
    [pathname, router, searchParams],
  );

  function onQueryChange(value: string) {
    setDraft(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => apply({ q: value.trim() }), 250);
  }

  return (
    // The search field takes a whole row on a phone; the filter and the
    // archived toggle share the next one. Squeezing all three onto one line at
    // 390px shrinks the search box to an icon and pushes the toggle's label off
    // the edge of the screen.
    <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto sm:flex-1">
      <div className="relative w-full min-w-0 sm:max-w-xs sm:flex-1">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          // Named for the search parameter it drives, so the field is
          // addressable — by a test, and by a browser restoring a form.
          name="q"
          value={draft}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          className="pl-9"
        />
        {draft !== "" && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Clear search"
            className="absolute top-1/2 right-1 -translate-y-1/2"
            onClick={() => {
              setDraft("");
              apply({ q: null });
            }}
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>

      {filterOptions && filterOptions.length > 0 && (
        <Select
          value={currentFilter || "__all"}
          onValueChange={(value) =>
            apply({ filter: value === "__all" ? null : value })
          }
        >
          <SelectTrigger className="w-40 shrink-0" aria-label={filterLabel}>
            <SelectValue placeholder={filterLabel} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">{filterLabel}</SelectItem>
            {filterOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {!hideArchived && (
        <div className="flex shrink-0 items-center gap-2">
          <Checkbox
            id="show-archived"
            checked={showArchived}
            onCheckedChange={(checked) =>
              apply({ archived: checked === true ? "1" : null })
            }
          />
          <Label htmlFor="show-archived" className="text-sm font-normal">
            {archivedLabel}
          </Label>
        </div>
      )}
    </div>
  );
}

/**
 * Page links for a server-paginated list.
 *
 * Renders nothing for a single page: pagination controls under six rows are
 * furniture that implies there is more to see.
 */
export function ListPagination({
  page,
  pageCount,
  total,
  noun,
}: {
  page: number;
  pageCount: number;
  total: number;
  noun: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function goTo(next: number) {
    const params = new URLSearchParams(searchParams.toString());
    if (next <= 1) params.delete("page");
    else params.set("page", String(next));
    const query = params.toString();
    router.replace((query ? `${pathname}?${query}` : pathname) as Route);
  }

  if (pageCount <= 1) {
    return (
      <p className="text-sm text-muted-foreground">
        {total} {total === 1 ? noun : `${noun}s`}
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">
        Page {page} of {pageCount} · {total} {total === 1 ? noun : `${noun}s`}
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => goTo(page - 1)}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pageCount}
          onClick={() => goTo(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
