import type { Metadata } from "next";
import { BadgeCheck, Building2, LogOut, ShieldCheck } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { VerifyEmailBanner } from "@/components/auth/verify-email-banner";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { formatCurrency, formatDate, initialsOf } from "@/lib/format";
import { fiscalYearLabel } from "@/lib/constants/india";
import { prisma } from "@/lib/db";
import { signOutAction } from "@/server/auth/actions";
import { requireCompanyContext } from "@/server/auth/context";
import { trialBalanceIsBalanced } from "@/lib/accounting/double-entry";

export const metadata: Metadata = {
  title: "Dashboard",
  robots: { index: false, follow: false },
};

/**
 * Interim landing page.
 *
 * Phase 4 replaces this with the real dashboard. What it does today is prove
 * the authentication and tenancy work end to end: it renders the resolved
 * session, the company the session is scoped to, the permissions the member
 * actually holds, and a trial balance computed from that company's journal
 * lines — all of which would be empty or wrong if any part of the chain were
 * broken.
 */
export default async function AppHomePage() {
  const context = await requireCompanyContext();
  const { user, company, membership, permissions } = context;

  // Scoped by companyId from the session — never from a URL or a prop.
  const [lines, accountCount, openingEntry] = await Promise.all([
    prisma.journalLine.groupBy({
      by: ["accountId"],
      where: { companyId: company.id, status: "POSTED" },
      _sum: { debit: true, credit: true },
    }),
    prisma.account.count({ where: { companyId: company.id } }),
    prisma.journalEntry.findFirst({
      where: { companyId: company.id, voucherType: "OPENING_BALANCE" },
      select: { entryNumber: true, entryDate: true, totalDebit: true },
    }),
  ]);

  const trialBalance = trialBalanceIsBalanced(
    lines.map((line) => ({
      debit: line._sum.debit ?? 0,
      credit: line._sum.credit ?? 0,
    })),
  );

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Logo size="md" />
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <form action={signOutAction}>
            <Button type="submit" variant="outline" size="sm">
              <LogOut className="size-4" />
              Sign out
            </Button>
          </form>
        </div>
      </header>

      <Separator className="my-8" />

      <div className="space-y-6">
        {!user.emailVerifiedAt && <VerifyEmailBanner email={user.email} />}

        <div className="flex items-start gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary text-sm font-semibold text-primary-foreground">
            {initialsOf(user.fullName)}
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Welcome, {user.fullName.split(" ")[0]}
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <Building2 className="size-3.5" />
              {company.name}
              <Badge variant="muted">{membership.roleName}</Badge>
              {company.isDemo && <Badge variant="warning">Demo data</Badge>}
              {user.emailVerifiedAt && (
                <Badge variant="success">
                  <BadgeCheck className="size-3" />
                  Verified
                </Badge>
              )}
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your books are ready</CardTitle>
            <CardDescription>
              Financial year{" "}
              {fiscalYearLabel(new Date(), company.fiscalYearStartMonth)} ·{" "}
              {accountCount} accounts in your chart of accounts
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Trial balance</dt>
                <dd className="mt-1 flex items-center gap-2 text-sm font-medium">
                  {trialBalance.balanced ? (
                    <>
                      <ShieldCheck className="size-4 text-success" />
                      Balanced
                    </>
                  ) : (
                    <span className="text-destructive">
                      Out of balance by{" "}
                      {formatCurrency(trialBalance.difference)}
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Total debits / credits
                </dt>
                <dd className="tabular-figures mt-1 text-sm font-medium">
                  {formatCurrency(trialBalance.totalDebit)} /{" "}
                  {formatCurrency(trialBalance.totalCredit)}
                </dd>
              </div>
              {openingEntry && (
                <>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Opening entry
                    </dt>
                    <dd className="mt-1 text-sm font-medium">
                      {openingEntry.entryNumber} ·{" "}
                      {formatDate(openingEntry.entryDate)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Opening capital
                    </dt>
                    <dd className="tabular-figures mt-1 text-sm font-medium">
                      {formatCurrency(openingEntry.totalDebit)}
                    </dd>
                  </div>
                </>
              )}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              What you can do in this business
            </CardTitle>
            <CardDescription>
              {permissions.size} permissions, from the {membership.roleName}{" "}
              role. Every protected operation checks these on the server.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1.5">
              {[...permissions]
                .sort()
                .slice(0, 24)
                .map((permission) => (
                  <Badge
                    key={permission}
                    variant="outline"
                    className="font-mono text-[0.6875rem]"
                  >
                    {permission}
                  </Badge>
                ))}
              {permissions.size > 24 && (
                <Badge variant="muted">+{permissions.size - 24} more</Badge>
              )}
            </div>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          This interim page confirms authentication and tenant scoping are
          working. The full dashboard arrives in Phase 4.
        </p>
      </div>
    </div>
  );
}
