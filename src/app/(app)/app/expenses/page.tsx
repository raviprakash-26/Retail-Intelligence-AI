import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/shell/module-placeholder";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "Expenses",
  robots: { index: false, follow: false },
};

export default async function ExpensesPage() {
  await requirePermission("expenses.view");

  return (
    <ModulePlaceholder
      title="Expenses"
      icon="Wallet"
      phase={8}
      description="Rent, salaries, electricity and everything else, categorised and posted to the right ledger automatically."
      willInclude={[
        "Sixteen built-in categories, plus your own",
        "Revenue and capital expenditure kept distinct",
        "Input tax credit where eligible",
        "Attachments for bills and receipts",
        "Expense trends and category breakdown",
      ]}
    />
  );
}
