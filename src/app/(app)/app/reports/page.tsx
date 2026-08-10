import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/shell/module-placeholder";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "Reports",
  robots: { index: false, follow: false },
};

export default async function ReportsPage() {
  await requirePermission("reports.view");

  return (
    <ModulePlaceholder
      title="Reports"
      icon="FileSpreadsheet"
      phase={39}
      description="Every report in one place, exportable to PDF, Excel and CSV."
      willInclude={[
        "Accounting: journal, ledger, trial balance, statements",
        "Business: sales, purchases, expenses, inventory, parties",
        "Compliance: GST and tax preparation",
        "AI: audit, forecast and financial health reports",
      ]}
    />
  );
}
