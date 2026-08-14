import type { Metadata } from "next";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { PartyManager } from "@/components/master-data/party-manager";
import { requirePermission } from "@/server/auth/context";
import { listParties } from "@/server/master-data/party-service";

export const metadata: Metadata = {
  title: "Suppliers",
  robots: { index: false, follow: false },
};

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("suppliers.view");
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const result = await listParties({
    companyId: context.company.id,
    kind: "SUPPLIER",
    query: single("q"),
    includeArchived: single("archived") === "1",
    page: Number(single("page") ?? 1) || 1,
  });

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="Suppliers"
        description="Who you buy from. An opening balance here is what you already owed them when you started using this system, and it posts to payables as a real journal entry."
      />

      <PartyManager
        kind="SUPPLIER"
        result={result}
        canManage={context.permissions.has("suppliers.manage")}
      />
    </div>
  );
}
