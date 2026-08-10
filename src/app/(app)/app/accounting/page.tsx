import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/shell/module-placeholder";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "Accounting",
  robots: { index: false, follow: false },
};

export default async function AccountingPage() {
  await requirePermission("accounting.view");

  return (
    <ModulePlaceholder
      title="Accounting"
      icon="BookOpenCheck"
      phase={11}
      description="The ledger itself — journal, ledger, trial balance and the statements derived from them."
      willInclude={[
        "Journal with voucher, account, date and amount filters",
        "Per-account ledger with running balance",
        "Trial balance, validated before any statement is produced",
        "Trading account, profit & loss and balance sheet",
        "Cash flow and receipts & payments account",
        "Chart of accounts management",
      ]}
    />
  );
}
