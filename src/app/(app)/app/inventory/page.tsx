import type { Metadata } from "next";
import { StockList } from "@/components/inventory/stock-list";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { requirePermission } from "@/server/auth/context";
import {
  getStockSummary,
  reconcileStock,
} from "@/server/inventory/inventory-report";

export const metadata: Metadata = {
  title: "Inventory",
  robots: { index: false, follow: false },
};

/**
 * What is on the shelves, and whether the books agree.
 *
 * Positions are not entered here — they are the consequence of the bills and
 * invoices already recorded. The only thing this page writes is a correction,
 * and that posts real accounting rather than editing a quantity.
 */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("inventory.view");
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    const found = Array.isArray(value) ? value[0] : value;
    return found || undefined;
  };

  const filter = single("filter");

  const [summary, reconciliation] = await Promise.all([
    getStockSummary({
      companyId: context.company.id,
      query: single("q"),
      filter: filter === "low" || filter === "out" ? filter : undefined,
      page: Number(single("page") ?? 1) || 1,
    }),
    reconcileStock(context.company.id),
  ]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="Inventory"
        description="What you hold and what it cost you. Every figure here is the consequence of a bill or an invoice you already recorded — nothing is typed in twice."
      />

      <StockList
        summary={summary}
        reconciliation={reconciliation}
        canAdjust={context.permissions.has("inventory.adjust")}
      />
    </div>
  );
}
