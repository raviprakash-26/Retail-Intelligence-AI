"use client";

import * as React from "react";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Download, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ReportPeriodKind } from "@/lib/reports/catalogue";

/**
 * Choosing the period, and taking the report away.
 *
 * The period lives in the URL like every other filter in this product, so a
 * report somebody found useful is a link they can send. The server reads the
 * same parameters and does the work; nothing here computes a figure.
 *
 * Export is an ordinary link to a route that returns the file, not a button
 * that assembles one in the browser. The browser gets a filename it trusts and
 * the page keeps no second copy of the tenant's ledger in memory.
 *
 * Print is the browser's own dialogue, which is also how a PDF is made. Saying
 * "Print" rather than "Download PDF" is the honest label: the product does not
 * render a PDF, it prints a page that has been laid out to print well.
 */
export function ReportControls({
  period,
  resolved,
  canExport,
}: {
  period: ReportPeriodKind;
  /**
   * The period the page actually ran, defaults included.
   *
   * The URL is often empty — somebody has just opened the report and the
   * server filled in the fiscal year. Reading the period from the URL would
   * then show blank date fields and, worse, build an export link with no
   * period on it at all, which the route can only refuse.
   */
  resolved: { from: string; to: string; year: number; month: number };
  canExport: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const apply = React.useCallback(
    (changes: Record<string, string>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      router.replace(`${pathname}?${next.toString()}` as Route);
    },
    [pathname, router, searchParams],
  );

  // Built from what the page ran, not from what the URL happens to say, so the
  // file is the report on screen even before anybody has touched a control.
  const exportQuery = new URLSearchParams({
    from: resolved.from,
    to: resolved.to,
    year: String(resolved.year),
    month: String(resolved.month),
  }).toString();
  const exportHref = `${pathname}/export?${exportQuery}`;

  return (
    <div className="flex flex-wrap items-end justify-between gap-4 print:hidden">
      <div className="flex flex-wrap items-end gap-3">
        {period === "range" && (
          <>
            <Field
              id="from"
              label="From"
              value={resolved.from}
              onChange={(value) => apply({ from: value })}
            />
            <Field
              id="to"
              label="To"
              value={resolved.to}
              onChange={(value) => apply({ to: value })}
            />
          </>
        )}

        {period === "asAt" && (
          <Field
            id="to"
            label="As at"
            value={resolved.to}
            onChange={(value) => apply({ to: value })}
          />
        )}

        {period === "month" && (
          <Field
            id="month"
            label="Month"
            type="month"
            value={`${resolved.year}-${String(resolved.month).padStart(2, "0")}`}
            onChange={(value) => {
              const [year, month] = value.split("-");
              apply({ year: year ?? "", month: String(Number(month ?? 0)) });
            }}
          />
        )}

        {period === "today" && (
          <p className="text-sm text-muted-foreground">
            Measured against today. Ageing is a position now, not a period.
          </p>
        )}
      </div>

      <div className="flex gap-2">
        <Button variant="outline" onClick={() => window.print()}>
          <Printer className="size-4" />
          Print
        </Button>
        {canExport && (
          <Button variant="outline" asChild>
            <a href={exportHref} download>
              <Download className="size-4" />
              Export CSV
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = "date",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "date" | "month";
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-44"
      />
    </div>
  );
}
