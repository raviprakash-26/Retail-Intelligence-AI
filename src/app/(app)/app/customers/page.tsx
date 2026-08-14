import type { Metadata } from "next";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { PartyManager } from "@/components/master-data/party-manager";
import { requirePermission } from "@/server/auth/context";
import { listParties } from "@/server/master-data/party-service";

export const metadata: Metadata = {
  title: "Customers",
  robots: { index: false, follow: false },
};

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("customers.view");
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const result = await listParties({
    companyId: context.company.id,
    kind: "CUSTOMER",
    query: single("q"),
    includeArchived: single("archived") === "1",
    page: Number(single("page") ?? 1) || 1,
  });

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="Customers"
        description="Who you sell to on credit. An opening balance here is what they already owed you when you started using this system, and it posts to receivables as a real journal entry."
      />

      <PartyManager
        kind="CUSTOMER"
        result={result}
        canManage={context.permissions.has("customers.manage")}
      />
    </div>
  );
}
