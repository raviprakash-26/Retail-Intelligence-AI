"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUpRight, BookOpen } from "lucide-react";
import { AccountPicker } from "@/components/accounting/account-picker";
import { ListPagination } from "@/components/master-data/list-toolbar";
import { Badge } from "@/components/ui/badge";
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
import { balanceSideLabel } from "@/lib/accounting/double-entry";
import { formatCurrency, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AccountNature } from "@prisma/client";
import type {
  AccountLedger,
  LedgerAccountOption,
} from "@/server/accounting/ledger-service";

/**
 * One account, line by line.
 *
 * Laid out the way a bahi khata is: what was carried in at the top, every
 * movement in date order, the balance running down the right, and what is
 * carried out at the bottom. A retailer who has kept a paper ledger recognises
 * this page immediately, which is the point — the software should look like the
 * thing it replaces before it looks like software.
 *
 * The running balance comes from the server, computed across the whole ordered
 * set. Accumulating it here would restart it at the top of every page.
 */
export function LedgerView({
  ledger,
  accounts,
  parties,
}: {
  ledger: AccountLedger | null;
  accounts: LedgerAccountOption[];
  parties: Array<{ id: string; name: string; archived: boolean }>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const selected = ledger
    ? {
        id: ledger.account.id,
        code: ledger.account.code,
        name: ledger.account.name,
        groupName: ledger.account.groupName,
        partyType: ledger.account.partyType,
      }
    : null;

  const apply = React.useCallback(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      // Any change to what is being looked at invalidates the page number.
      next.delete("page");
      router.push(`/app/accounting/ledger?${next.toString()}` as Route);
    },
    [router, searchParams],
  );

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_10rem_10rem]">
        <label className="flex flex-col gap-1.5 text-xs">
          <span className="text-muted-foreground">Account</span>
          <AccountPicker
            name="ledger-account"
            value={selected}
            accounts={accounts.map((account) => ({
              id: account.id,
              code: account.code,
              name: account.name,
              groupName: account.groupName,
              partyType: account.partyType,
            }))}
            onSelect={(account) => apply({ account: account.id, party: null })}
          />
        </label>

        {/* The window the entries below were read for — the financial year in
            the header until somebody picks another. Blank fields would say
            there was no window, with an opening balance sitting above them. */}
        <DateField
          label="From"
          value={searchParams.get("from") ?? ledger?.from ?? ""}
          onChange={(value) => apply({ from: value })}
        />
        <DateField
          label="To"
          value={searchParams.get("to") ?? ledger?.to ?? ""}
          onChange={(value) => apply({ to: value })}
        />
      </div>

      {ledger?.account.partyType && parties.length > 0 && (
        <label className="flex max-w-sm flex-col gap-1.5 text-xs">
          <span className="text-muted-foreground">
            {ledger.account.partyType === "CUSTOMER"
              ? "One customer only"
              : "One supplier only"}
          </span>
          <Select
            value={searchParams.get("party") ?? "__all__"}
            onValueChange={(value) =>
              apply({ party: value === "__all__" ? null : value })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Everybody</SelectItem>
              {parties.map((party) => (
                <SelectItem key={party.id} value={party.id}>
                  {/*
                    An archived party is here because they still have movement
                    on the control account. Said plainly, so picking a name
                    somebody thought they had put away is not a surprise.
                  */}
                  {party.archived ? `${party.name} (archived)` : party.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      )}

      {!ledger ? (
        <div className="rounded-xl border border-dashed px-6 py-16 text-center">
          <BookOpen
            className="mx-auto size-8 text-muted-foreground"
            aria-hidden="true"
          />
          <h2 className="mt-3 text-base font-semibold">Choose an account</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            Every account in your chart has a ledger — each movement in date
            order with the balance running down beside it. Pick one above.
          </p>
        </div>
      ) : (
        <LedgerTable ledger={ledger} />
      )}
    </div>
  );
}

function LedgerTable({ ledger }: { ledger: AccountLedger }) {
  const hasWindow = Boolean(ledger.from || ledger.to);

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-xl border">
        <Table className="border-0">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Date</TableHead>
              <TableHead>Particulars</TableHead>
              <TableHead className="text-right">Debit</TableHead>
              <TableHead className="text-right">Credit</TableHead>
              <TableHead className="pr-4 text-right">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {hasWindow && (
              <TableRow className="bg-secondary/40">
                <TableCell className="pl-4 text-xs text-muted-foreground">
                  {formatDate(ledger.from ?? "", { style: "short" })}
                </TableCell>
                <TableCell className="text-sm font-medium">
                  Balance brought forward
                </TableCell>
                <TableCell />
                <TableCell />
                <TableCell className="tabular-figures pr-4 text-right text-sm font-medium">
                  <Signed
                    value={ledger.openingBalance}
                    nature={ledger.account.nature}
                  />
                </TableCell>
              </TableRow>
            )}

            {ledger.rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  Nothing was posted to this account
                  {hasWindow ? " in this period" : " yet"}.
                </TableCell>
              </TableRow>
            ) : (
              ledger.rows.map((row) => (
                <TableRow key={row.lineId}>
                  <TableCell className="pl-4 align-top text-xs whitespace-nowrap text-muted-foreground">
                    {formatDate(row.date, { style: "short" })}
                  </TableCell>
                  <TableCell className="align-top">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Link
                        href={`/app/accounting/journal/${row.entryId}` as Route}
                        className={cn(
                          "font-mono text-xs underline-offset-4 hover:underline",
                          row.reversed && "line-through",
                        )}
                      >
                        {row.entryNumber}
                      </Link>
                      {row.source ? (
                        <Badge variant="muted" className="text-[0.625rem]">
                          {row.source}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[0.625rem]">
                          By hand
                        </Badge>
                      )}
                      {row.reversed && (
                        <Badge variant="danger" className="text-[0.625rem]">
                          Reversed
                        </Badge>
                      )}
                    </span>
                    <p className="mt-0.5 max-w-md text-sm">
                      {row.partyName && (
                        <span className="font-medium">{row.partyName} · </span>
                      )}
                      <span className="text-muted-foreground">
                        {row.lineNarration ?? row.narration ?? "—"}
                      </span>
                    </p>
                    {row.documentHref && (
                      <Link
                        href={row.documentHref as Route}
                        className="mt-0.5 inline-flex items-center gap-0.5 text-xs text-primary underline-offset-4 hover:underline"
                      >
                        Open the {row.source?.toLowerCase()}
                        <ArrowUpRight className="size-3" />
                      </Link>
                    )}
                  </TableCell>
                  <TableCell className="tabular-figures text-right align-top text-sm">
                    {Number(row.debit) === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      formatCurrency(row.debit)
                    )}
                  </TableCell>
                  <TableCell className="tabular-figures text-right align-top text-sm">
                    {Number(row.credit) === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      formatCurrency(row.credit)
                    )}
                  </TableCell>
                  <TableCell className="tabular-figures pr-4 text-right align-top text-sm font-medium">
                    <Signed
                      value={row.running}
                      nature={ledger.account.nature}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}

            <TableRow className="bg-secondary/40">
              <TableCell />
              <TableCell className="text-sm font-semibold">
                {hasWindow ? "Carried forward" : "Balance"}
              </TableCell>
              <TableCell className="tabular-figures text-right text-sm font-medium">
                {formatCurrency(ledger.periodDebit, {
                  compactZeroDecimals: true,
                })}
              </TableCell>
              <TableCell className="tabular-figures text-right text-sm font-medium">
                {formatCurrency(ledger.periodCredit, {
                  compactZeroDecimals: true,
                })}
              </TableCell>
              <TableCell className="tabular-figures pr-4 text-right text-base font-semibold">
                <Signed
                  value={ledger.closingBalance}
                  nature={ledger.account.nature}
                />
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <ListPagination
        page={ledger.page}
        pageCount={ledger.pageCount}
        total={ledger.total}
        noun="line"
      />
    </div>
  );
}

/**
 * A balance with the side it sits on.
 *
 * Shown as a positive figure plus Dr or Cr rather than as a negative number,
 * because that is how a ledger reads and because "−₹300" against a customer is
 * ambiguous in a way "₹300 Cr" is not.
 *
 * Which means the tag has to be right, and it needs the account's nature to
 * be: these figures are signed against it, so on a credit-nature account a
 * positive balance is a credit. Deciding from the sign alone put every row of
 * every liability, income and capital ledger on the wrong side.
 */
function Signed({ value, nature }: { value: string; nature: AccountNature }) {
  const amount = Number(value);
  if (amount === 0) return <span className="text-muted-foreground">—</span>;

  return (
    <>
      {formatCurrency(Math.abs(amount))}
      <span className="ml-1 text-[0.6875rem] text-muted-foreground">
        {balanceSideLabel({ nature, balance: value })}
      </span>
    </>
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
        name={`ledger-${label.toLowerCase()}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
      />
    </label>
  );
}
