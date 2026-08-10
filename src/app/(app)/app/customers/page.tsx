import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/shell/module-placeholder";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "Customers",
  robots: { index: false, follow: false },
};

export default async function CustomersPage() {
  await requirePermission("customers.view");

  return (
    <ModulePlaceholder
      title="Customers"
      icon="Users"
      phase={5}
      description="Who you sell to, what they owe, and the ledger behind it."
      willInclude={[
        "Contact details, GSTIN and credit limits",
        "Outstanding balance and transaction history",
        "Per-customer ledger from the same journal as your accounts",
        "Credit limit warnings at the point of sale",
      ]}
    />
  );
}
