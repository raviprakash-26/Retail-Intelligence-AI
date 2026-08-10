import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/shell/module-placeholder";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "Forecasting",
  robots: { index: false, follow: false },
};

export default async function ForecastingPage() {
  await requirePermission("forecasting.view");

  return (
    <ModulePlaceholder
      title="Forecasting"
      icon="TrendingUp"
      phase={19}
      description="Projections built from your own trading history, shown as ranges with their limits stated."
      willInclude={[
        "Revenue, expense, profit and cash-flow projections",
        "Confidence ranges rather than false precision",
        "Stated model assumptions and limitations",
        "Historical accuracy tracking",
      ]}
    />
  );
}
