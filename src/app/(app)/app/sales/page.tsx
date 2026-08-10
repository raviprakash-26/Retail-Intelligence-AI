import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/shell/module-placeholder";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "Sales",
  robots: { index: false, follow: false },
};

export default async function SalesPage() {
  await requirePermission("sales.view");

  return (
    <ModulePlaceholder
      title="Sales"
      icon="ReceiptIndianRupee"
      phase={6}
      description="Record what you sell. Every invoice posts its own balanced journal entry, moves stock and records the tax — you enter it once."
      willInclude={[
        "Invoicing with cash, bank, UPI, card and credit payment modes",
        "Automatic GST split by place of supply",
        "Sales returns against the original invoice",
        "Customer outstanding and ageing",
        "Sales analytics by product and customer",
      ]}
    />
  );
}
