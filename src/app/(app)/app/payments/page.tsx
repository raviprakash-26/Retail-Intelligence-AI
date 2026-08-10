import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/shell/module-placeholder";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "Payments",
  robots: { index: false, follow: false },
};

export default async function PaymentsPage() {
  await requirePermission("payments.view");

  return (
    <ModulePlaceholder
      title="Payments"
      icon="ArrowUpFromLine"
      phase={9}
      description="Money going out — supplier settlements, salaries, loan repayments and drawings."
      willInclude={[
        "Allocation against specific bills",
        "Cash and bank sources",
        "Automatic journal posting",
        "Payment scheduling and due reminders",
      ]}
    />
  );
}
