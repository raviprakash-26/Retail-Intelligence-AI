import type { Metadata } from "next";
import { TrialBalanceView } from "@/components/accounting/trial-balance-view";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { requirePermission } from "@/server/auth/context";
import { getTrialBalance } from "@/server/accounting/trial-balance-service";

export const metadata: Metadata = {
  title: "Trial balance",
  robots: { index: false, follow: false },
};

/**
 * The checkpoint between the ledger and the statements.
 *
 * Produced from the same balance engine everything else reads, so it cannot
 * disagree with the chart of accounts or with any ledger reached from it.
 */
export default async function TrialBalancePage({
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

  const trial = await getTrialBalance({
    companyId: context.company.id,
    from: single("from"),
    to: single("to"),
    includeEmpty: single("empty") === "1",
  });

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="Trial balance"
        description="Every account with a balance, in two columns. Give it a start date as well and it shows what was carried in and what moved, which is what an accountant wants at year end."
      />

      <TrialBalanceView trial={trial} />
    </div>
  );
}
