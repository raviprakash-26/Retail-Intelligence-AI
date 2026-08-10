import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/shell/module-placeholder";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "Products",
  robots: { index: false, follow: false },
};

export default async function ProductsPage() {
  await requirePermission("products.view");

  return (
    <ModulePlaceholder
      title="Products"
      icon="Package"
      phase={5}
      description="What you buy and sell. Stock, margins and GST all follow from these records."
      willInclude={[
        "SKU, barcode, HSN code and unit",
        "Purchase price, selling price and GST rate",
        "Opening stock and minimum stock levels",
        "Categories and units",
      ]}
    />
  );
}
