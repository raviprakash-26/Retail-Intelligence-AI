import type { Metadata } from "next";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { ProductManager } from "@/components/master-data/product-manager";
import { requirePermission } from "@/server/auth/context";
import { listProducts } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";

export const metadata: Metadata = {
  title: "Products",
  robots: { index: false, follow: false },
};

/**
 * Filters arrive as URL parameters and are applied by the database, so a tenant
 * with ten thousand products ships one page of them to the browser rather than
 * all of them plus a client-side filter.
 */
export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("products.view");
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const [result, taxonomy] = await Promise.all([
    listProducts({
      companyId: context.company.id,
      query: single("q"),
      categoryId: single("filter"),
      includeArchived: single("archived") === "1",
      page: Number(single("page") ?? 1) || 1,
    }),
    getProductTaxonomy(context.company.id),
  ]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="Products"
        description="What you sell. Each item carries its own GST rate and HSN code, so an invoice works out its own tax — and its opening stock is posted to the ledger rather than sitting outside the books."
      />

      <ProductManager
        result={result}
        taxonomy={taxonomy}
        canManage={context.permissions.has("products.manage")}
      />
    </div>
  );
}
