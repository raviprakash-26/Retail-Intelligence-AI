import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/shell/module-placeholder";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "Receipts",
  robots: { index: false, follow: false },
};

export default async function ReceiptsPage() {
  await requirePermission("receipts.view");

  return (
    <ModulePlaceholder
      title="Receipts"
      icon="ArrowDownToLine"
      phase={9}
      description="Money coming in — customer collections, other income, loans and capital introduced."
      willInclude={[
        "Allocation against specific invoices so ageing stays accurate",
        "Cash, bank, UPI, card and cheque",
        "Automatic journal posting",
        "Receipts and payments account",
      ]}
    />
  );
}
