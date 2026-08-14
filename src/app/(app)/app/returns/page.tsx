import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { ReturnsList } from "@/components/returns/returns-list";
import { formatCurrency } from "@/lib/format";
import { requireCompanyContext } from "@/server/auth/context";
import {
  listPurchaseReturns,
  listSalesReturns,
  type ReturnListResult,
} from "@/server/returns/return-queries";

export const metadata: Metadata = {
  title: "Returns",
  robots: { index: false, follow: false },
};

/**
 * Returns, both directions.
 *
 * The page is reachable by anyone who may see sales *or* purchases, so the gate
 * is written out here rather than through `requirePermission`, which asks about
 * a single key. Someone with only one of the two sees only that side — no tab
 * strip, no second list, and a URL asking for the other direction is refused
 * rather than quietly redirected.
 */
export default async function ReturnsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requireCompanyContext();
  const canSeeSales = context.permissions.has("sales.view");
  const canSeePurchases = context.permissions.has("purchases.view");
  if (!canSeeSales && !canSeePurchases) forbidden();

  const params = await searchParams;
  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const asked = single("type");
  const kind: "sales" | "purchase" =
    asked === "purchase" || (!canSeeSales && canSeePurchases)
      ? "purchase"
      : "sales";
  if (kind === "sales" ? !canSeeSales : !canSeePurchases) forbidden();

  const query = {
    companyId: context.company.id,
    query: single("q"),
    page: Number(single("page") ?? 1) || 1,
  };
  const result: ReturnListResult =
    kind === "sales"
      ? await listSalesReturns(query)
      : await listPurchaseReturns(query);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="Returns"
        description="Goods that came back. A return does not edit the document it reverses — it posts its own balanced entry, moves the stock the other way and puts negative rows into the GST register, which is what a credit or debit note is."
        aside={
          Number(result.postedTotal) > 0 ? (
            <div className="rounded-lg border px-4 py-2.5">
              <p className="text-xs text-muted-foreground">
                {result.kind === "sales" ? "Credited" : "Debited"}
              </p>
              <p className="tabular-figures text-lg font-semibold">
                {formatCurrency(result.postedTotal, {
                  compactZeroDecimals: true,
                })}
              </p>
            </div>
          ) : undefined
        }
      />

      <ReturnsList
        result={result}
        canSeeSales={canSeeSales}
        canSeePurchases={canSeePurchases}
      />
    </div>
  );
}
