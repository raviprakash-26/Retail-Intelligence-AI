import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { StatementsView } from "@/components/accounting/statements-view";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { requirePermission } from "@/server/auth/context";
import { resolveFiscalYear } from "@/server/fiscal/fiscal-service";
import {
  getFinancialStatements,
  summarise,
  type FinancialStatements,
} from "@/server/accounting/statements-service";
import { TrialBalanceUnbalancedError } from "@/server/accounting/trial-balance-service";

export const metadata: Metadata = {
  title: "Financial statements",
  robots: { index: false, follow: false },
};

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * The trading account, profit and loss account and balance sheet.
 *
 * Defaults to the selected fiscal year, because that is the period anyone
 * asking for a balance sheet means. All three are derived from the same posted
 * lines as the ledger and the trial balance, and refuse to render at all if the
 * ledger does not balance.
 */
export default async function StatementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("accounting.view");
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    const found = Array.isArray(value) ? value[0] : value;
    return found || undefined;
  };

  const year = await resolveFiscalYear(context.company.id);
  const from = single("from") ?? (year ? isoDay(year.startDate) : "2000-01-01");
  const to = single("to") ?? (year ? isoDay(year.endDate) : isoDay(new Date()));

  let statements: FinancialStatements | null = null;
  let unbalanced: string | null = null;

  try {
    statements = await getFinancialStatements({
      companyId: context.company.id,
      from,
      to,
    });
  } catch (error) {
    if (error instanceof TrialBalanceUnbalancedError)
      unbalanced = error.message;
    else throw error;
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="Financial statements"
        description="What the business earned, what it cost to earn it, and what it is worth — built from the same entries as everything else, so no figure here can disagree with a ledger."
      />

      {unbalanced ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-5 py-4">
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <AlertTriangle className="size-4" />
            No statement can be produced
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-destructive">
            {unbalanced}
          </p>
          <Link
            href="/app/accounting/trial-balance"
            className="mt-3 inline-block text-sm font-medium underline underline-offset-4"
          >
            Open the trial balance
          </Link>
        </div>
      ) : (
        statements && (
          <StatementsView
            statements={statements}
            notes={summarise(statements)}
          />
        )
      )}
    </div>
  );
}
