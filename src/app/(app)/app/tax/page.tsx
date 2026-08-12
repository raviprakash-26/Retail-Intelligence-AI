import type { Metadata } from "next";
import { IncomeTaxWorkingPaper } from "@/components/tax/income-tax-working-paper";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { requirePermission } from "@/server/auth/context";
import {
  listFiscalYears,
  resolveFiscalYear,
} from "@/server/fiscal/fiscal-service";
import { getTaxWorkingPaper } from "@/server/tax/income-tax-service";

export const metadata: Metadata = {
  title: "Income tax",
  robots: { index: false, follow: false },
};

/**
 * The income tax working paper.
 *
 * An estimate, always, and it says so before it says anything else. The book
 * profit comes from the same statements engine as the profit and loss account,
 * the adjustments between the two are each shown with their reason, and the
 * judgement calls are left as a second figure rather than folded into the
 * first. Filing happens on the income tax portal, by a person who has reviewed
 * this with an accountant.
 */
export default async function IncomeTaxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("tax.view");
  const params = await searchParams;

  const requested = params.year;
  const single = Array.isArray(requested) ? requested[0] : requested;

  const [years, year] = await Promise.all([
    listFiscalYears(context.company.id),
    // A year id from the query string is a suggestion: `resolveFiscalYear`
    // only honours one that belongs to this company.
    resolveFiscalYear(context.company.id, single || null),
  ]);

  const paper = year
    ? await getTaxWorkingPaper({
        companyId: context.company.id,
        fiscalYearId: year.id,
      })
    : null;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="Income tax"
        description="An estimate of the tax on this year's business income, worked out from your books. It is prepared for your accountant to review — filing happens on the income tax portal."
      />

      {paper ? (
        <IncomeTaxWorkingPaper
          paper={paper}
          years={years.map((option) => ({
            id: option.id,
            label: option.label,
          }))}
        />
      ) : (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <h2 className="text-base font-semibold">No financial year is open</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            A computation needs a year to compute. Finish setting the business
            up and this fills itself in from the books.
          </p>
        </div>
      )}
    </div>
  );
}
