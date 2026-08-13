import type { Metadata } from "next";
import { ForecastView } from "@/components/forecast/forecast-view";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { FEATURE } from "@/lib/billing/plans";
import { PlanLocked } from "@/components/billing/plan-locked";
import { featureGate } from "@/server/billing/guards";
import { requirePermission } from "@/server/auth/context";
import { getForecast } from "@/server/forecast/forecast-service";

export const metadata: Metadata = {
  title: "Forecasting",
  robots: { index: false, follow: false },
};

/**
 * Forecasting.
 *
 * Ranges, never figures. The revenue panel fits a line through recorded weeks
 * and draws a band from how far those weeks fell from it; the cash panel rolls
 * forward commitments that already exist. Both are deterministic arithmetic on
 * this tenant's own books — no model produced any of it.
 */
export default async function ForecastingPage() {
  const context = await requirePermission("forecasting.view");

  // The navigation marks this when a plan does not include it, but marking is
  // presentation. Anybody can type the URL, so the page asks as well.
  const gate = await featureGate(context.company.id, FEATURE.FORECASTING);
  if (!gate.included) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
        <PlanLocked
          feature={FEATURE.FORECASTING}
          planName={gate.entitlements.planName}
          availableOn={gate.availableOn}
        />
      </div>
    );
  }
  const report = await getForecast({ companyId: context.company.id });

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="Forecasting"
        description="Where the next few weeks look like they are heading, as a range rather than a figure. Everything here is arithmetic on entries you have already posted."
      />
      <ForecastView report={report} />
    </div>
  );
}
