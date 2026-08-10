"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CalendarRange, Check, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatDate } from "@/lib/format";
import { setFiscalYearAction } from "@/server/search/actions";

export type FiscalYearChoice = {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  isClosed: boolean;
};

/**
 * Financial-year selector.
 *
 * Scopes every report and listing. The selection lives in a cookie so it
 * survives navigation and reloads; the server re-validates it against the
 * company's own years on each request, because a cookie is client data.
 */
export function FiscalYearSelector({
  years,
  selectedId,
}: {
  years: FiscalYearChoice[];
  selectedId: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const selected = years.find((year) => year.id === selectedId) ?? years[0];

  if (!selected) return null;

  // One year is not a choice; showing a dropdown implies otherwise.
  if (years.length === 1) {
    return (
      <span className="text-muted-foreground hidden items-center gap-1.5 text-sm sm:flex">
        <CalendarRange className="size-4" aria-hidden="true" />
        FY {selected.label}
      </span>
    );
  }

  async function choose(id: string) {
    if (id === selectedId) return;
    setPending(true);
    try {
      await setFiscalYearAction(id);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" loading={pending} className="gap-1.5">
          <CalendarRange className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">FY </span>
          {selected.label}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel>Financial year</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {years.map((year) => (
          <DropdownMenuItem
            key={year.id}
            onClick={() => choose(year.id)}
            className="gap-2"
          >
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                {year.label}
                {year.isClosed && (
                  <Lock className="size-3 text-muted-foreground" aria-label="Closed" />
                )}
              </p>
              <p className="text-muted-foreground text-xs">
                {formatDate(year.startDate, { style: "short" })} –{" "}
                {formatDate(year.endDate, { style: "short" })}
              </p>
            </div>
            {year.id === selected.id && (
              <Check className="text-primary size-4 shrink-0" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
