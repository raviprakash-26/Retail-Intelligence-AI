"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatCurrency, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  FinancialStatements,
  StatementGroup,
} from "@/server/accounting/statements-service";

/**
 * The three statements.
 *
 * Each is laid out as a vertical statement rather than the two-sided T-account
 * of a textbook, because that is how every reader under sixty has seen one and
 * because it survives a phone screen. Every line links to the ledger behind it,
 * so "why is Rent ₹48,000" is one click rather than a phone call.
 *
 * Negative figures are shown in brackets and labelled, never as a bare minus:
 * a contra account reducing a total is a different thing from a negative
 * balance, and on a balance sheet the difference matters.
 */
export function StatementsView({
  statements,
  notes,
}: {
  statements: FinancialStatements;
  notes: string[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const apply = React.useCallback(
    (changes: Record<string, string>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      router.push(`/app/accounting/statements?${next.toString()}` as Route);
    },
    [router, searchParams],
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <DateField
          label="From"
          value={statements.from}
          onChange={(value) => apply({ from: value })}
        />
        <DateField
          label="To"
          value={statements.to}
          onChange={(value) => apply({ to: value })}
        />
      </div>

      {statements.empty ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <h2 className="text-base font-semibold">Nothing to report yet</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            No transactions fall in this period. Record a sale, a bill or an
            expense and these statements build themselves from the entries.
          </p>
        </div>
      ) : (
        <>
          {notes.length > 0 && (
            <div className="rounded-xl border px-5 py-4">
              <h2 className="text-sm font-semibold">What this says</h2>
              <ul className="mt-2 space-y-1.5">
                {notes.map((note) => (
                  <li key={note} className="text-sm leading-relaxed">
                    {note}
                  </li>
                ))}
              </ul>
              <p className="mt-3 border-t pt-2.5 text-xs leading-relaxed text-muted-foreground">
                Every figure above is read straight off the statements below.
                Nothing here is an estimate, and none of it is tax or accounting
                advice — have your accountant review the statements before they
                are relied on or filed.
              </p>
            </div>
          )}

          <Tabs defaultValue="trading">
            <TabsList>
              <TabsTrigger value="trading">Trading</TabsTrigger>
              <TabsTrigger value="pl">Profit &amp; loss</TabsTrigger>
              <TabsTrigger value="bs">Balance sheet</TabsTrigger>
            </TabsList>

            <TabsContent value="trading" className="pt-5">
              <TradingPanel statements={statements} />
            </TabsContent>
            <TabsContent value="pl" className="pt-5">
              <ProfitAndLossPanel statements={statements} />
            </TabsContent>
            <TabsContent value="bs" className="pt-5">
              <BalanceSheetPanel statements={statements} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

function TradingPanel({ statements }: { statements: FinancialStatements }) {
  const { trading } = statements;
  const loss = Number(trading.grossProfit) < 0;

  return (
    <Statement
      title="Trading account"
      subtitle={`${formatDate(statements.from, { style: "short" })} to ${formatDate(statements.to, { style: "short" })}`}
    >
      <Section heading="Revenue" groups={trading.revenue} />
      <Total label="Total revenue" amount={trading.revenueTotal} />

      <Section heading="Cost of sales" groups={trading.costOfSales} />
      <Total label="Total cost of sales" amount={trading.costOfSalesTotal} />

      <Total
        label={loss ? "Gross loss" : "Gross profit"}
        amount={trading.grossProfit}
        emphasis
        note={
          trading.grossMarginPercent !== null
            ? `${trading.grossMarginPercent}% of revenue`
            : undefined
        }
      />

      <Note>
        Your books track stock continuously: a bill puts goods into stock, and a
        sale takes their cost out of stock at the moment it happens. So there is
        no Purchases line here and no closing-stock adjustment — the cost shown
        is the cost of what was actually sold, which is the figure the textbook
        layout is working towards anyway.
      </Note>
    </Statement>
  );
}

function ProfitAndLossPanel({
  statements,
}: {
  statements: FinancialStatements;
}) {
  const { profitAndLoss } = statements;
  const loss = Number(profitAndLoss.netProfit) < 0;

  return (
    <Statement
      title="Profit and loss account"
      subtitle={`${formatDate(statements.from, { style: "short" })} to ${formatDate(statements.to, { style: "short" })}`}
    >
      <Row label="Gross profit" amount={profitAndLoss.grossProfit} />

      {profitAndLoss.otherIncome.length > 0 && (
        <>
          <Section heading="Other income" groups={profitAndLoss.otherIncome} />
          <Total
            label="Total other income"
            amount={profitAndLoss.otherIncomeTotal}
          />
        </>
      )}

      <Section heading="Running costs" groups={profitAndLoss.expenses} />
      <Total label="Total running costs" amount={profitAndLoss.expensesTotal} />

      <Total
        label={loss ? "Net loss" : "Net profit"}
        amount={profitAndLoss.netProfit}
        emphasis
        note={
          profitAndLoss.netMarginPercent !== null
            ? `${profitAndLoss.netMarginPercent}% of revenue`
            : undefined
        }
      />

      <Note>
        Money the owner takes out of the business is not here — drawings reduce
        your capital on the balance sheet rather than the profit. Nor is
        anything spent on something the shop keeps and uses; that is an asset,
        and only its depreciation reaches this page.
      </Note>
    </Statement>
  );
}

function BalanceSheetPanel({
  statements,
}: {
  statements: FinancialStatements;
}) {
  const { balanceSheet } = statements;

  return (
    <Statement
      title="Balance sheet"
      subtitle={`As at ${formatDate(statements.to, { style: "long" })}`}
    >
      <Section heading="What the business owns" groups={balanceSheet.assets} />
      <Total label="Total assets" amount={balanceSheet.assetsTotal} emphasis />

      <Section heading="What it owes" groups={balanceSheet.liabilities} />
      <Total label="Total liabilities" amount={balanceSheet.liabilitiesTotal} />

      <Section heading="Your stake" groups={balanceSheet.equity} />
      <Row
        label="Profit not yet closed to capital"
        amount={balanceSheet.earningsToDate}
      />
      <Total label="Total capital" amount={balanceSheet.equityTotal} />

      <Total
        label="Liabilities and capital"
        amount={balanceSheet.fundingTotal}
        emphasis
      />

      <div
        className={cn(
          "mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3",
          !balanceSheet.balanced && "border-destructive/40 bg-destructive/5",
        )}
      >
        {balanceSheet.balanced ? (
          <>
            <span className="flex items-center gap-2 text-sm font-medium text-success-foreground">
              <CheckCircle2 className="size-4" />
              The two sides agree
            </span>
            <span className="text-xs text-muted-foreground">
              What the business owns equals what it owes plus your stake.
            </span>
          </>
        ) : (
          <span className="flex items-center gap-2 text-sm font-medium text-destructive">
            <AlertTriangle className="size-4" />
            Out by {formatCurrency(balanceSheet.difference)} — this should be
            impossible and needs investigating before these figures are used.
          </span>
        )}
      </div>

      <Note>
        Profit is shown inside your capital rather than as a separate line at
        the bottom, because it is yours the moment it is earned. It stays listed
        separately until a year-end closing entry folds it into capital
        properly, which this system does not do yet.
      </Note>
    </Statement>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Statement({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border">
      <div className="border-b px-5 py-4">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

function Section({
  heading,
  groups,
}: {
  heading: string;
  groups: StatementGroup[];
}) {
  if (groups.length === 0) {
    return (
      <div className="mt-4 first:mt-0">
        <h3 className="text-sm font-semibold">{heading}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Nothing in this period.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-5 first:mt-0">
      <h3 className="text-sm font-semibold">{heading}</h3>
      {groups.map((group) => (
        <div key={group.code} className="mt-2.5">
          {groups.length > 1 && (
            <p className="text-xs text-muted-foreground">{group.name}</p>
          )}
          <dl>
            {group.lines.map((line) => (
              <div
                key={line.accountId}
                className="flex items-baseline justify-between gap-4 py-1"
              >
                <dt className="min-w-0 text-sm">
                  <Link
                    href={
                      `/app/accounting/ledger?account=${line.accountId}` as Route
                    }
                    className="underline-offset-4 hover:underline"
                  >
                    {line.name}
                  </Link>
                </dt>
                <dd className="tabular-figures shrink-0 text-sm">
                  <Amount value={line.amount} />
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

function Row({ label, amount }: { label: string; amount: string }) {
  return (
    <div className="mt-3 flex items-baseline justify-between gap-4 border-t pt-2.5">
      <span className="text-sm">{label}</span>
      <span className="tabular-figures text-sm">
        <Amount value={amount} />
      </span>
    </div>
  );
}

function Total({
  label,
  amount,
  emphasis,
  note,
}: {
  label: string;
  amount: string;
  emphasis?: boolean;
  note?: string;
}) {
  return (
    <div
      className={cn(
        "mt-2 flex flex-wrap items-baseline justify-between gap-3 border-t pt-2.5",
        emphasis && "border-foreground/20",
      )}
    >
      <span
        className={cn(
          "text-sm font-medium",
          emphasis && "text-base font-semibold",
        )}
      >
        {label}
        {note && (
          <Badge variant="muted" className="ml-2 font-normal">
            {note}
          </Badge>
        )}
      </span>
      <span
        className={cn(
          "tabular-figures text-sm font-medium",
          emphasis && "text-lg font-semibold",
        )}
      >
        <Amount value={amount} />
      </span>
    </div>
  );
}

/**
 * A figure, with negatives in brackets.
 *
 * Accounting convention, and it earns its place: a bare minus sign in a column
 * of right-aligned numbers is easy to miss, and on a balance sheet missing one
 * changes the reading entirely.
 */
function Amount({ value }: { value: string }) {
  const amount = Number(value);
  if (amount === 0) return <span className="text-muted-foreground">—</span>;
  if (amount < 0) {
    return (
      <span className="text-destructive">
        ({formatCurrency(Math.abs(amount), { compactZeroDecimals: true })})
      </span>
    );
  }
  return <>{formatCurrency(amount, { compactZeroDecimals: true })}</>;
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-5 flex items-start gap-2 border-t pt-3 text-xs leading-relaxed text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
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
        name={`fs-${label.toLowerCase()}`}
        defaultValue={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
      />
    </label>
  );
}
