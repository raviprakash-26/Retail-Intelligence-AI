"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDate } from "@/lib/format";
import type { TrialBalance } from "@/server/accounting/trial-balance-service";

/**
 * The trial balance.
 *
 * Two columns, every account with a balance in one of them, totalled at the
 * bottom. Each account name links to its ledger, because "why is Rent ₹48,000"
 * is the next question and it should be one click away.
 *
 * The note at the foot is the honest part. A balanced trial balance says the
 * arithmetic holds, not that the books are right — a purchase posted to Rent
 * balances perfectly and is still wrong. Saying so costs nothing and stops the
 * report being read as a clean bill of health.
 */
export function TrialBalanceView({ trial }: { trial: TrialBalance }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const apply = React.useCallback(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      router.push(`/app/accounting/trial-balance?${next.toString()}` as Route);
    },
    [router, searchParams],
  );

  const showEmpty = searchParams.get("empty") === "1";
  const columns = trial.hasWindow ? 8 : 4;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <DateField
            label="From"
            value={searchParams.get("from") ?? ""}
            onChange={(value) => apply({ from: value })}
          />
          <DateField
            label="As at"
            value={searchParams.get("to") ?? ""}
            onChange={(value) => apply({ to: value })}
          />
        </div>

        <div className="flex items-center gap-2">
          {trial.omitted > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => apply({ empty: showEmpty ? null : "1" })}
            >
              {showEmpty ? "Hide empty accounts" : "Show empty accounts"}
              <Badge variant="muted" className="ml-1">
                {trial.omitted}
              </Badge>
            </Button>
          )}
        </div>
      </div>

      <BalanceBanner trial={trial} />

      <div className="overflow-x-auto rounded-xl border">
        <Table className="border-0">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Account</TableHead>
              {trial.hasWindow && (
                <>
                  <TableHead className="text-right">Opening Dr</TableHead>
                  <TableHead className="text-right">Opening Cr</TableHead>
                  <TableHead className="text-right">Period Dr</TableHead>
                  <TableHead className="text-right">Period Cr</TableHead>
                </>
              )}
              <TableHead className="text-right">Debit</TableHead>
              <TableHead className="pr-4 text-right">Credit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {trial.sections.map((section) => (
              <React.Fragment key={section.type}>
                <TableRow className="bg-secondary/40">
                  <TableCell
                    className="pl-4 text-sm font-semibold"
                    colSpan={columns - 2}
                  >
                    {section.label}
                  </TableCell>
                  <TableCell className="tabular-figures text-right text-sm font-medium">
                    {Number(section.subtotalDebit) === 0
                      ? "—"
                      : formatCurrency(section.subtotalDebit, {
                          compactZeroDecimals: true,
                        })}
                  </TableCell>
                  <TableCell className="tabular-figures pr-4 text-right text-sm font-medium">
                    {Number(section.subtotalCredit) === 0
                      ? "—"
                      : formatCurrency(section.subtotalCredit, {
                          compactZeroDecimals: true,
                        })}
                  </TableCell>
                </TableRow>

                {section.rows.map((row) => (
                  <TableRow key={row.accountId}>
                    <TableCell className="pl-8">
                      <Link
                        href={
                          `/app/accounting/ledger?account=${row.accountId}` as Route
                        }
                        className="text-sm underline-offset-4 hover:underline"
                      >
                        {row.name}
                      </Link>
                      <p className="font-mono text-xs text-muted-foreground">
                        {row.code}
                        {!row.isActive && " · retired"}
                      </p>
                    </TableCell>
                    {trial.hasWindow && (
                      <>
                        <Amount value={row.openingDebit} />
                        <Amount value={row.openingCredit} />
                        <Amount value={row.periodDebit} />
                        <Amount value={row.periodCredit} />
                      </>
                    )}
                    <Amount value={row.closingDebit} />
                    <Amount value={row.closingCredit} className="pr-4" />
                  </TableRow>
                ))}
              </React.Fragment>
            ))}

            <TableRow className="bg-secondary/60">
              <TableCell
                className="pl-4 text-sm font-semibold"
                colSpan={columns - 2}
              >
                Total
              </TableCell>
              <TableCell className="tabular-figures text-right text-base font-semibold">
                {formatCurrency(trial.totalDebit, {
                  compactZeroDecimals: true,
                })}
              </TableCell>
              <TableCell className="tabular-figures pr-4 text-right text-base font-semibold">
                {formatCurrency(trial.totalCredit, {
                  compactZeroDecimals: true,
                })}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span>
          The two columns agreeing means the arithmetic holds — it does not mean
          the books are right. A purchase recorded against Rent instead of
          Purchases balances perfectly and is still wrong. Every account name
          links to its ledger, which is where a figure that looks odd gets
          explained.
        </span>
      </p>
    </div>
  );
}

function BalanceBanner({ trial }: { trial: TrialBalance }) {
  if (trial.balanced) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border px-5 py-3.5">
        <span className="flex items-center gap-2 text-sm font-medium text-success-foreground">
          <CheckCircle2 className="size-4" />
          Debits equal credits
        </span>
        <span className="text-xs text-muted-foreground">
          {trial.shown} accounts with a balance
          {trial.from
            ? `, ${formatDate(trial.from, { style: "short" })} to ${formatDate(trial.to, { style: "short" })}`
            : ` as at ${formatDate(trial.to, { style: "short" })}`}
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-5 py-4">
      <p className="flex items-center gap-2 text-sm font-medium text-destructive">
        <AlertTriangle className="size-4" />
        The ledger does not balance — out by {formatCurrency(trial.difference)}
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-destructive">
        This should be impossible. Every entry is checked when it is posted and
        again by the database before it is allowed to exist, so a difference
        here points at data changed outside the application rather than at
        anything you did. No financial statement can be produced until it is
        investigated.
      </p>
    </div>
  );
}

function Amount({ value, className }: { value: string; className?: string }) {
  return (
    <TableCell
      className={`tabular-figures text-right text-sm ${className ?? ""}`}
    >
      {Number(value) === 0 ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        formatCurrency(value, { compactZeroDecimals: true })
      )}
    </TableCell>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="date"
        name={`tb-${label.toLowerCase().replace(/\s+/g, "-")}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
      />
    </label>
  );
}
