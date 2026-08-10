import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/shell/module-placeholder";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "Purchases",
  robots: { index: false, follow: false },
};

export default async function PurchasesPage() {
  await requirePermission("purchases.view");

  return (
    <ModulePlaceholder
      title="Purchases"
      icon="ShoppingCart"
      phase={7}
      description="Record what you buy. Stock, supplier payables and input tax credit all follow from the bill."
      willInclude={[
        "Supplier bills with credit periods",
        "Input tax credit tracking and eligibility",
        "Purchase returns and debit notes",
        "Supplier outstanding and ageing",
        "Landed cost feeding stock valuation",
      ]}
    />
  );
}
