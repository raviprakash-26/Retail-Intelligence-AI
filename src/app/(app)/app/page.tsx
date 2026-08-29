import type { Metadata } from "next";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { VerifyEmailBanner } from "@/components/auth/verify-email-banner";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { SetupChecklist } from "@/components/onboarding/setup-checklist";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { TooltipProvider } from "@/components/ui/tooltip";
import { prisma } from "@/lib/db";
import { formatCurrency, formatDate } from "@/lib/format";
import { requirePermission } from "@/server/auth/context";
import { selectedFiscalYear } from "@/server/fiscal/fiscal-service";
import { getOnboardingChecklist } from "@/server/company/onboarding-service";
import { getDashboardOverview } from "@/server/dashboard/overview";

export const metadata: Metadata = {
  title: "Dashboard",
  robots: { index: false, follow: false },
};

/**
 * Dashboard.
 *
 * Every figure is read from the module that owns it, through
 * `getDashboardOverview`, so the front page cannot disagree with the report a
 * shopkeeper opens to check it.
 *
 * The pending state stays, because a ₹0 tile is indistinguishable from a
 * business that genuinely earned nothing and on a financial dashboard that is
 * not a cosmetic difference. What it no longer does is name a module that has
 * shipped: eight of the twelve tiles sat blank for years behind notes like
 * "Arrives with the Sales module", long after sales, purchases, expenses,
 * inventory, receipts and GST had all arrived. The only thing that can make a
 * tile pending now is a ledger that does not balance, which is a condition of
 * the books rather than of the product.
 */
export default async function DashboardPage() {
  // `dashboard.view` decided which navigation items to draw and guarded
  // nothing, which was harmless while every role held it and nobody could
  // build one that did not. Custom roles changed that: a business can now
  // deliberately leave it out, and until this line that intention was ignored
  // — the item disappeared from the sidebar and the page opened anyway to
  // anybody who typed the address.
  const context = await requirePermission("dashboard.view");
  const { user, company, permissions } = context;

  const fiscalYear = await selectedFiscalYear(company.id);

  // Every figure comes from the module that owns it. The dashboard used to run
  // its own groupBy over the journal, which is a second way of computing a
  // balance and therefore a second answer waiting to happen.
  const [overview, checklist, openingEntry] = await Promise.all([
    getDashboardOverview({
      companyId: company.id,
      from: fiscalYear?.startDate ?? new Date(0),
      to: fiscalYear?.endDate ?? new Date(),
    }),
    getOnboardingChecklist({
      companyId: company.id,
      emailVerified: Boolean(user.emailVerifiedAt),
      permissions,
    }),
    prisma.journalEntry.findFirst({
      where: { companyId: company.id, voucherType: "OPENING_BALANCE" },
      select: { entryNumber: true, entryDate: true, totalDebit: true },
    }),
  ]);

  const trialBalance = overview.books;
  const hasLedger = !overview.empty;
  const currency = company.currency;
  const inYear = fiscalYear
    ? `In ${fiscalYear.label}`
    : "Since the books opened";
  const asMoney = (amount: string) => formatCurrency(amount, { currency });

  return (
    <TooltipProvider>
      <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Good to see you, {user.fullName.split(" ")[0]}
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {company.name}
              {fiscalYear && (
                <Badge variant="muted">FY {fiscalYear.label}</Badge>
              )}
              {company.isDemo && <Badge variant="warning">Demo data</Badge>}
            </p>
          </div>
        </div>

        {!user.emailVerifiedAt && <VerifyEmailBanner email={user.email} />}

        {/* The trial balance is the one health check that matters before any
            statement is trusted, so it is stated on the dashboard rather than
            buried in the accounting module. */}
        {hasLedger && !trialBalance.balanced && (
          <Alert variant="destructive">
            <ShieldAlert />
            <AlertTitle>Your trial balance does not balance</AlertTitle>
            <AlertDescription>
              <p>
                Debits and credits differ by{" "}
                <span className="tabular-figures font-medium">
                  {formatCurrency(trialBalance.difference, { currency })}
                </span>
                . Financial statements will not be produced until this is
                resolved. Please contact support — this should not be possible.
              </p>
            </AlertDescription>
          </Alert>
        )}

        <SetupChecklist checklist={checklist} />

        <section aria-labelledby="position-heading" className="space-y-3">
          <h2 id="position-heading" className="text-sm font-semibold">
            Your position
          </h2>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="Cash in hand"
              value={asMoney(overview.cash)}
              hint="Balance of the cash ledger, from posted entries only."
            />
            <KpiCard
              label="Bank balance"
              value={asMoney(overview.bank)}
              hint="Balance of the bank ledger, from posted entries only."
            />
            <KpiCard
              label="Owner's capital"
              value={asMoney(overview.capital)}
              hint="What the owner has introduced, less drawings."
            />
            <KpiCard
              label="Trial balance"
              value={trialBalance.balanced ? "Balanced" : "Out of balance"}
              hint="Total debits must equal total credits across every posted line."
            />
          </div>
        </section>

        <section aria-labelledby="trading-heading" className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="trading-heading" className="text-sm font-semibold">
              Trading
            </h2>
            <p className="text-xs text-muted-foreground">{inYear}</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="Sales"
              value={
                overview.trading ? asMoney(overview.trading.revenue) : undefined
              }
              pending={!overview.trading}
              pendingNote="Needs a ledger that balances."
              hint="Revenue from posted invoices, less credit notes, in the selected year."
            />
            <KpiCard
              label="Purchases"
              value={
                overview.trading
                  ? asMoney(overview.trading.purchases)
                  : undefined
              }
              pending={!overview.trading}
              pendingNote="Needs a ledger that balances."
              hint="What was bought on posted bills, less debit notes, in the selected year. Stock is held at cost, so this is not the cost of what was sold."
            />
            <KpiCard
              label="Expenses"
              value={
                overview.trading
                  ? asMoney(overview.trading.expenses)
                  : undefined
              }
              pending={!overview.trading}
              pendingNote="Needs a ledger that balances."
              hint="Running costs for the year, excluding the cost of goods sold."
            />
            <KpiCard
              label="Gross profit"
              value={
                overview.trading
                  ? asMoney(overview.trading.grossProfit)
                  : undefined
              }
              note={
                overview.trading?.grossMarginPercent === null
                  ? // Nil revenue is not the only way to get here: a period in
                    // which more came back than went out has revenue below nil,
                    // which cannot carry a percentage either. Naming the wrong
                    // reason is worse than naming none.
                    "No sales to read a margin against yet"
                  : overview.trading
                    ? `${overview.trading.grossMarginPercent}% margin`
                    : undefined
              }
              pending={!overview.trading}
              pendingNote="Needs a ledger that balances."
              hint="Sales less the cost of what was sold, from the trading account."
            />
            <KpiCard
              label="Receivables"
              value={asMoney(overview.receivables)}
              note={`${asMoney(overview.receivablesOverdue)} overdue`}
              hint="What customers owe on posted invoices, as things stand."
            />
            <KpiCard
              label="Payables"
              value={asMoney(overview.payables)}
              note={`${asMoney(overview.payablesOverdue)} overdue`}
              hint="What the business owes suppliers on posted bills, as things stand."
            />
            <KpiCard
              label="Inventory value"
              value={asMoney(overview.inventoryValue)}
              hint="Stock on hand at cost, across every tracked product."
            />
            <KpiCard
              label="GST on the books"
              value={asMoney(overview.gstOnTheBooks)}
              note="Ledger position, not a filed return"
              hint="Output tax less input credit, as the ledger has it. A return is filed for one month and carries credit forward; the GST page produces that figure."
            />
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Your books</CardTitle>
              <CardDescription>
                {fiscalYear
                  ? `Financial year ${fiscalYear.label}`
                  : "No financial year configured"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="divide-y text-sm">
                <div className="flex items-baseline justify-between gap-4 py-2.5">
                  <dt className="text-muted-foreground">Posted accounts</dt>
                  <dd className="tabular-figures font-medium">
                    {trialBalance.postedAccounts}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4 py-2.5">
                  <dt className="text-muted-foreground">Total debits</dt>
                  <dd className="tabular-figures font-medium">
                    {formatCurrency(trialBalance.totalDebit, { currency })}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4 py-2.5">
                  <dt className="text-muted-foreground">Total credits</dt>
                  <dd className="tabular-figures font-medium">
                    {formatCurrency(trialBalance.totalCredit, { currency })}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4 py-2.5">
                  <dt className="text-muted-foreground">Balance check</dt>
                  <dd className="flex items-center gap-1.5 font-medium">
                    {trialBalance.balanced ? (
                      <>
                        <ShieldCheck className="size-4 text-success" />
                        Balanced
                      </>
                    ) : (
                      <span className="text-destructive">
                        Off by{" "}
                        {formatCurrency(trialBalance.difference, { currency })}
                      </span>
                    )}
                  </dd>
                </div>
                {openingEntry && (
                  <div className="flex items-baseline justify-between gap-4 py-2.5">
                    <dt className="text-muted-foreground">Opening entry</dt>
                    <dd className="font-medium">
                      {openingEntry.entryNumber} ·{" "}
                      {formatDate(openingEntry.entryDate)}
                    </dd>
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">What comes next</CardTitle>
              <CardDescription>
                The dashboard fills in as each module lands.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3 text-sm">
                {[
                  {
                    phase: 5,
                    label: "Master data",
                    detail: "Products, customers, suppliers",
                  },
                  {
                    phase: 6,
                    label: "Sales",
                    detail: "Invoicing, payment modes, outstanding",
                  },
                  {
                    phase: 10,
                    label: "Accounting engine",
                    detail: "Automatic posting for every document",
                  },
                  {
                    phase: 14,
                    label: "Financial statements",
                    detail: "Trading, P&L, balance sheet, cash flow",
                  },
                ].map((step) => (
                  <li key={step.phase} className="flex gap-3">
                    <span className="tabular-figures flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary text-[0.6875rem] font-semibold text-secondary-foreground">
                      {step.phase}
                    </span>
                    <span>
                      <span className="font-medium">{step.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {step.detail}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>
    </TooltipProvider>
  );
}
