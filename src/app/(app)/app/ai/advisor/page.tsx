import type { Metadata } from "next";
import { cookies } from "next/headers";
import { AdvisorView } from "@/components/advisor/advisor-view";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { isRangeKey, type RangeKey } from "@/lib/analytics/range";
import { requirePermission } from "@/server/auth/context";
import {
  FISCAL_YEAR_COOKIE,
  resolveFiscalYear,
} from "@/server/fiscal/fiscal-service";
import { getAdvice } from "@/server/advisor/advisor-service";

export const metadata: Metadata = {
  title: "AI Business Advisor",
  robots: { index: false, follow: false },
};

/**
 * The advisor.
 *
 * A fixed set of detectors over figures the platform has already computed. Each
 * suggestion says what the books show, what it is worth — as a recorded amount,
 * an estimate with its assumption, or an admission that there is no honest
 * figure — and when a shopkeeper would be right to ignore it.
 */
export default async function AdvisorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("ai.advisor");
  const params = await searchParams;
  const cookieStore = await cookies();

  const requested = params.range;
  const single = Array.isArray(requested) ? requested[0] : requested;
  const range: RangeKey = isRangeKey(single) ? single : "fy";

  const fiscalYear = await resolveFiscalYear(
    context.company.id,
    cookieStore.get(FISCAL_YEAR_COOKIE)?.value,
  );

  const report = fiscalYear
    ? await getAdvice({
        companyId: context.company.id,
        range,
        fiscalYearStart: fiscalYear.startDate,
        fiscalYearEnd: fiscalYear.endDate,
      })
    : null;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="AI Business Advisor"
        description="A handful of things your own books can notice — cash sitting with customers, stock sitting still, margin slipping — each with what it is worth and the reasons you might rightly ignore it."
      />

      {report ? (
        <AdvisorView report={report} />
      ) : (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <h2 className="text-base font-semibold">No financial year is open</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            Suggestions are worked out over a period. Finish setting the
            business up and this fills itself in from the books.
          </p>
        </div>
      )}
    </div>
  );
}
