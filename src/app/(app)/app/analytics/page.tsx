import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/shell/module-placeholder";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "Analytics",
  robots: { index: false, follow: false },
};

export default async function AnalyticsPage() {
  await requirePermission("analytics.view");

  return (
    <ModulePlaceholder
      title="Analytics"
      icon="ChartColumnBig"
      phase={18}
      description="Where the money actually comes from, and where it goes."
      willInclude={[
        "Revenue, profit and expense growth",
        "Product and customer profitability",
        "Inventory turnover and working capital",
        "Eleven financial ratios with formula, trend and interpretation",
        "Financial health score",
      ]}
    />
  );
}
