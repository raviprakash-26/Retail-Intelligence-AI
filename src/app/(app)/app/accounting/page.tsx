import type { Metadata } from "next";
import { ChartOfAccounts } from "@/components/accounting/chart-of-accounts";
import { EquationPanel } from "@/components/accounting/equation-panel";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { toStorageString } from "@/lib/money";
import { requirePermission } from "@/server/auth/context";
import { getChartOfAccounts } from "@/server/accounting/account-service";
import {
  accountBalances,
  accountingEquation,
} from "@/server/accounting/balances";

export const metadata: Metadata = {
  title: "Accounting",
  robots: { index: false, follow: false },
};

/**
 * The chart of accounts, and proof that it holds together.
 *
 * This is the backbone every later report reads. Showing it — with the real
 * balance beside every line and the accounting equation at the top — is how a
 * retailer sees that the figures on the dashboard came from somewhere, rather
 * than being asked to take them on faith.
 */
export default async function AccountingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("accounting.view");
  const params = await searchParams;
  const raw = params.inactive;
  const showInactive = (Array.isArray(raw) ? raw[0] : raw) === "1";

  const [chart, balances] = await Promise.all([
    getChartOfAccounts({
      companyId: context.company.id,
      includeInactive: showInactive,
    }),
    accountBalances({ companyId: context.company.id }),
  ]);

  const equation = accountingEquation(balances);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="Chart of accounts"
        description="Every account your books can post to, and what each one currently holds. The sales, purchases and expenses you record all land here — this is where they become accounting."
      />

      <EquationPanel
        equation={{
          assets: toStorageString(equation.assets),
          liabilities: toStorageString(equation.liabilities),
          equity: toStorageString(equation.equity),
          profit: toStorageString(equation.profit),
          difference: toStorageString(equation.difference),
          balanced: equation.balanced,
        }}
        asOfLabel="up to today"
      />

      <ChartOfAccounts
        tree={chart.tree}
        groups={chart.groups}
        counts={chart.counts}
        canManage={context.permissions.has("accounting.accounts.manage")}
        showInactive={showInactive}
      />
    </div>
  );
}
