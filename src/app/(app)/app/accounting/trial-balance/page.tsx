import type { Metadata } from "next";
import { TrialBalanceView } from "@/components/accounting/trial-balance-view";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { requirePermission } from "@/server/auth/context";
import { getTrialBalance } from "@/server/accounting/trial-balance-service";
import { selectedFiscalYear } from "@/server/fiscal/fiscal-service";

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

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

  // Defaulted to the year chosen in the header, which is also the shape an
  // accountant wants: what was carried in at the start of the year, what moved
  // during it, where each account closed. The date fields on the page still
  // win, so any other window is a URL away.
  const year = await selectedFiscalYear(context.company.id);

  const trial = await getTrialBalance({
    companyId: context.company.id,
    from: single("from") ?? (year ? isoDay(year.startDate) : undefined),
    to: single("to") ?? (year ? isoDay(year.endDate) : undefined),
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
