import type { Metadata } from "next";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { SalesList } from "@/components/sales/sales-list";
import { formatCurrency } from "@/lib/format";
import { requirePermission } from "@/server/auth/context";
import { listSales } from "@/server/sales/sale-service";

export const metadata: Metadata = {
  title: "Sales",
  robots: { index: false, follow: false },
};

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("sales.view");
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const result = await listSales({
    companyId: context.company.id,
    query: single("q"),
    status: single("filter"),
    page: Number(single("page") ?? 1) || 1,
  });

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="Sales"
        description="Every invoice you have raised. Each one posts its own balanced journal entry, moves the stock it sold and records the tax — nothing here is entered twice."
        aside={
          Number(result.postedTotal) > 0 ? (
            <div className="flex gap-6 rounded-lg border px-4 py-2.5">
              <div>
                <p className="text-muted-foreground text-xs">Invoiced</p>
                <p className="tabular-figures text-lg font-semibold">
                  {formatCurrency(result.postedTotal, {
                    compactZeroDecimals: true,
                  })}
                </p>
              </div>
              {Number(result.creditOutstanding) > 0 && (
                <div>
                  <p className="text-muted-foreground text-xs">On credit</p>
                  <p className="tabular-figures text-lg font-semibold">
                    {formatCurrency(result.creditOutstanding, {
                      compactZeroDecimals: true,
                    })}
                  </p>
                </div>
              )}
            </div>
          ) : undefined
        }
      />

      <SalesList
        result={result}
        canCreate={context.permissions.has("sales.create")}
      />
    </div>
  );
}
