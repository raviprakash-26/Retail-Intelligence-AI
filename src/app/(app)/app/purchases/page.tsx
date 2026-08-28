import type { Metadata } from "next";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { PurchasesList } from "@/components/purchases/purchases-list";
import { formatCurrency } from "@/lib/format";
import { requirePermission } from "@/server/auth/context";
import { listPurchases } from "@/server/purchases/purchase-service";

export const metadata: Metadata = {
  title: "Purchases",
  robots: { index: false, follow: false },
};

export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("purchases.view");
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const result = await listPurchases({
    companyId: context.company.id,
    query: single("q"),
    status: single("filter"),
    page: Number(single("page") ?? 1) || 1,
  });

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="Purchases"
        description="Every supplier bill you have recorded. Each one brings stock in at what it cost, holds the GST you paid as credit against the GST you collect, and tracks what you still owe."
        aside={
          Number(result.postedTotal) > 0 ? (
            <div className="flex gap-6 rounded-lg border px-4 py-2.5">
              <div>
                <p className="text-xs text-muted-foreground">Billed</p>
                <p className="tabular-figures text-lg font-semibold">
                  {formatCurrency(result.postedTotal, {
                    compactZeroDecimals: true,
                  })}
                </p>
              </div>
              {Number(result.inputCredit) > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground">Input credit</p>
                  <p className="tabular-figures text-lg font-semibold">
                    {formatCurrency(result.inputCredit, {
                      compactZeroDecimals: true,
                    })}
                  </p>
                </div>
              )}
              {Number(result.payablesOutstanding) > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground">Owed</p>
                  <p className="tabular-figures text-lg font-semibold">
                    {formatCurrency(result.payablesOutstanding, {
                      compactZeroDecimals: true,
                    })}
                  </p>
                </div>
              )}
            </div>
          ) : undefined
        }
      />

      <PurchasesList
        result={result}
        canCreate={context.permissions.has("purchases.create")}
      />
    </div>
  );
}
