import "server-only";
import { prisma } from "@/lib/db";

/**
 * Global search.
 *
 * Searches only the record types that exist today — customers, suppliers,
 * products and ledger accounts. Transactions and journal entries join as their
 * modules land. Returning nothing for a document type that cannot yet exist is
 * honest; pretending to search it is not.
 *
 * Every query is scoped by companyId taken from the caller's session.
 */

export type SearchResultKind =
  | "customer"
  | "supplier"
  | "product"
  | "account"
  | "page";

export type SearchResult = {
  id: string;
  kind: SearchResultKind;
  title: string;
  subtitle: string | null;
  href: string;
};

const PER_KIND_LIMIT = 5;

export async function globalSearch(params: {
  companyId: string;
  query: string;
  /** Result kinds the caller is allowed to see, from their permissions. */
  allowed: ReadonlySet<SearchResultKind>;
}): Promise<SearchResult[]> {
  const query = params.query.trim();
  // Two characters is the point at which a prefix search stops matching almost
  // everything, and below it the query costs more than it returns.
  if (query.length < 2) return [];

  const { companyId, allowed } = params;
  const contains = { contains: query, mode: "insensitive" as const };

  const [customers, suppliers, products, accounts] = await Promise.all([
    allowed.has("customer")
      ? prisma.customer.findMany({
          where: {
            companyId,
            archivedAt: null,
            OR: [{ name: contains }, { code: contains }, { phone: contains }, { gstin: contains }],
          },
          select: { id: true, name: true, code: true, phone: true },
          take: PER_KIND_LIMIT,
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),

    allowed.has("supplier")
      ? prisma.supplier.findMany({
          where: {
            companyId,
            archivedAt: null,
            OR: [{ name: contains }, { code: contains }, { phone: contains }, { gstin: contains }],
          },
          select: { id: true, name: true, code: true, phone: true },
          take: PER_KIND_LIMIT,
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),

    allowed.has("product")
      ? prisma.product.findMany({
          where: {
            companyId,
            archivedAt: null,
            OR: [{ name: contains }, { sku: contains }, { barcode: contains }, { hsnCode: contains }],
          },
          select: { id: true, name: true, sku: true, sellingPrice: true },
          take: PER_KIND_LIMIT,
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),

    allowed.has("account")
      ? prisma.account.findMany({
          where: {
            companyId,
            isActive: true,
            OR: [{ name: contains }, { code: contains }],
          },
          select: { id: true, name: true, code: true, type: true },
          take: PER_KIND_LIMIT,
          orderBy: { code: "asc" },
        })
      : Promise.resolve([]),
  ]);

  return [
    ...customers.map((customer) => ({
      id: customer.id,
      kind: "customer" as const,
      title: customer.name,
      subtitle: customer.phone ?? customer.code,
      href: `/app/customers/${customer.id}`,
    })),
    ...suppliers.map((supplier) => ({
      id: supplier.id,
      kind: "supplier" as const,
      title: supplier.name,
      subtitle: supplier.phone ?? supplier.code,
      href: `/app/suppliers/${supplier.id}`,
    })),
    ...products.map((product) => ({
      id: product.id,
      kind: "product" as const,
      title: product.name,
      subtitle: product.sku,
      href: `/app/products/${product.id}`,
    })),
    ...accounts.map((account) => ({
      id: account.id,
      kind: "account" as const,
      title: account.name,
      subtitle: `${account.code} · ${account.type.toLowerCase()}`,
      href: `/app/accounting/ledger?account=${account.id}`,
    })),
  ];
}
