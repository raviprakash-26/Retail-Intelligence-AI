import type { Metadata } from "next";
import { AnalyticsView } from "@/components/analytics/analytics-view";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { FEATURE } from "@/lib/billing/plans";
import { PlanLocked } from "@/components/billing/plan-locked";
import { featureGate } from "@/server/billing/guards";
import { requirePermission } from "@/server/auth/context";
import { selectedFiscalYear } from "@/server/fiscal/fiscal-service";
import { isRangeKey, type RangeKey } from "@/lib/analytics/range";
import { getAnalytics } from "@/server/analytics/analytics-service";

export const metadata: Metadata = {
  title: "Analytics",
  robots: { index: false, follow: false },
};

/**
 * Analytics.
 *
 * Arithmetic on posted entries, read through the same balance engine as the
 * statements — so nothing here can disagree with the profit and loss account.
 * Nothing is predicted and nothing is modelled; forecasting is a separate thing
 * and is labelled as such where it arrives.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("analytics.view");

  // The navigation marks this when a plan does not include it, but marking is
  // presentation. Anybody can type the URL, so the page asks as well.
  const gate = await featureGate(context.company.id, FEATURE.ANALYTICS);
  if (!gate.included) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
        <PlanLocked
          feature={FEATURE.ANALYTICS}
          planName={gate.entitlements.planName}
          availableOn={gate.availableOn}
        />
      </div>
    );
  }
  const params = await searchParams;

  const requested = params.range;
  const single = Array.isArray(requested) ? requested[0] : requested;
  const range: RangeKey = isRangeKey(single) ? single : "fy";

  const fiscalYear = await selectedFiscalYear(context.company.id);

  const report = fiscalYear
    ? await getAnalytics({
        companyId: context.company.id,
        range,
        fiscalYearStart: fiscalYear.startDate,
        fiscalYearEnd: fiscalYear.endDate,
      })
    : null;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="Analytics"
        description="What the shop actually did, cut the ways you would ask about it. Every figure is arithmetic on entries you have already posted — nothing here is predicted."
      />

      {report ? (
        <AnalyticsView report={report} />
      ) : (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <h2 className="text-base font-semibold">No financial year is open</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            Analytics needs a period to report on. Finish setting the business
            up and this fills itself in from the books.
          </p>
        </div>
      )}
    </div>
  );
}
