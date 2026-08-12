import type { Metadata } from "next";
import { ForecastView } from "@/components/forecast/forecast-view";
import { MasterDataHeader } from "@/components/master-data/page-header";
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
