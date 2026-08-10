import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/shell/module-placeholder";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "Suppliers",
  robots: { index: false, follow: false },
};

export default async function SuppliersPage() {
  await requirePermission("suppliers.view");

  return (
    <ModulePlaceholder
      title="Suppliers"
      icon="Truck"
      phase={5}
      description="Who you buy from, what you owe, and since when."
      willInclude={[
        "Contact details, GSTIN and credit periods",
        "Outstanding balance and bill history",
        "Per-supplier ledger",
        "Payment due tracking",
      ]}
    />
  );
}
