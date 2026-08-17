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
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import {
  signedBalance,
  trialBalanceIsBalanced,
} from "@/lib/accounting/double-entry";
import { prisma } from "@/lib/db";
import { formatCurrency, formatDate } from "@/lib/format";
import { requirePermission } from "@/server/auth/context";
import { selectedFiscalYear } from "@/server/fiscal/fiscal-service";
import { getOnboardingChecklist } from "@/server/company/onboarding-service";

export const metadata: Metadata = {
  title: "Dashboard",
  robots: { index: false, follow: false },
};

/**
 * Dashboard.
 *
 * Shows only figures that can be computed from what exists today — cash, bank
 * and capital come straight from posted journal lines. Everything that depends
 * on a module still to be built is rendered in a pending state that says so,
 * rather than as a zero. A ₹0 revenue tile is indistinguishable from a business
 * that sold nothing, and on a financial dashboard that difference matters.
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

  const [balances, checklist, openingEntry] = await Promise.all([
    // Grouped by account so the ledger figures below are derived, never stored.
    prisma.journalLine.groupBy({
      by: ["accountId"],
      where: {
        companyId: company.id,
        status: "POSTED",
        ...(fiscalYear
          ? {
              entryDate: { gte: fiscalYear.startDate, lte: fiscalYear.endDate },
            }
          : {}),
      },
      _sum: { debit: true, credit: true },
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

  const accountIds = balances.map((balance) => balance.accountId);
  const accounts = await prisma.account.findMany({
    where: { companyId: company.id, id: { in: accountIds } },
    select: { id: true, systemKey: true, nature: true },
  });
  const accountById = new Map(accounts.map((account) => [account.id, account]));

  const balanceFor = (systemKey: string) => {
    const account = accounts.find((entry) => entry.systemKey === systemKey);
    if (!account) return null;
    const row = balances.find((balance) => balance.accountId === account.id);
    if (!row) return null;
    return signedBalance(
      account.nature,
      row._sum.debit ?? 0,
      row._sum.credit ?? 0,
    );
  };

  const cash = balanceFor(SYSTEM_ACCOUNT.CASH);
  const bank = balanceFor(SYSTEM_ACCOUNT.BANK);
  const capital = balanceFor(SYSTEM_ACCOUNT.OWNER_CAPITAL);

  const trialBalance = trialBalanceIsBalanced(
    balances.map((balance) => ({
      debit: balance._sum.debit ?? 0,
      credit: balance._sum.credit ?? 0,
    })),
  );

  const hasLedger = balances.length > 0;
  const currency = company.currency;

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
              value={formatCurrency(cash ?? 0, { currency })}
              hint="Balance of the cash ledger, from posted entries only."
            />
            <KpiCard
              label="Bank balance"
              value={formatCurrency(bank ?? 0, { currency })}
              hint="Balance of the bank ledger, from posted entries only."
            />
            <KpiCard
              label="Owner's capital"
              value={formatCurrency(capital ?? 0, { currency })}
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
            <p className="text-xs text-muted-foreground">
              Populated as each module is built
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="Sales this month"
              pending
              pendingNote="Arrives with the Sales module."
            />
            <KpiCard
              label="Purchases"
              pending
              pendingNote="Arrives with the Purchases module."
            />
            <KpiCard
              label="Expenses"
              pending
              pendingNote="Arrives with the Expenses module."
            />
            <KpiCard
              label="Gross profit"
              pending
              pendingNote="Needs sales and stock valuation."
            />
            <KpiCard
              label="Receivables"
              pending
              pendingNote="Arrives with Sales and Receipts."
            />
            <KpiCard
              label="Payables"
              pending
              pendingNote="Arrives with Purchases and Payments."
            />
            <KpiCard
              label="Inventory value"
              pending
              pendingNote="Arrives with the Inventory module."
            />
            <KpiCard
              label="GST payable"
              pending
              pendingNote="Arrives with the GST module."
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
                    {accountById.size}
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
