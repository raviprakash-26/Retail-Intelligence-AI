import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { add, money, toStorageString } from "@/lib/money";
import { MasterDataError } from "@/server/master-data/errors";

/**
 * Reading returns back.
 *
 * Both return tables carry `productId` without a relation to Product, so the
 * item rows are joined to their products in a second query rather than through
 * Prisma. That is deliberate on the schema's part — a return item keeps the
 * quantity, rate and cost it was posted with even if the product is later
 * archived or renamed — and it means the join has to be explicit here.
 *
 * Every query in this file is filtered by `companyId` in its own `where`. None
 * of them takes the company from the record it just read.
 */

const RETURN_PAGE_SIZE = 25;

export type ReturnKind = "sales" | "purchase";

/**
 * A line on an invoice or bill, and how much of it may still come back.
 *
 * Deliberately identical for both directions. The form that records a return is
 * the same form either way — pick lines, say how many — and giving the two
 * shapes different field names would fork it for no reason.
 */
export type ReturnableLine = {
  /** The id of the line on the original document, not of the product. */
  lineId: string;
  productName: string;
  sku: string;
  /** What the original document carried on this line. */
  originalQuantity: string;
  alreadyReturned: string;
  returnable: string;
  /** The rate the original document charged, which the return will reuse. */
  rate: string;
};

export type ReturnRow = {
  id: string;
  returnNumber: string;
  returnDate: Date;
  /** The document this reverses, if it still exists. */
  againstNumber: string | null;
  partyName: string;
  reason: string | null;
  taxableAmount: string;
  taxAmount: string;
  totalAmount: string;
};

export type ReturnListResult = {
  kind: ReturnKind;
  rows: ReturnRow[];
  total: number;
  page: number;
  pageCount: number;
  /** Posted returns in the filtered set. */
  postedTotal: string;
  postedTaxable: string;
};

type Moneyish = Prisma.Decimal | null;

function taxOf(row: {
  cgstAmount: Moneyish;
  sgstAmount: Moneyish;
  igstAmount: Moneyish;
  cessAmount: Moneyish;
}): string {
  return toStorageString(
    add(
      row.cgstAmount ?? 0,
      row.sgstAmount ?? 0,
      row.igstAmount ?? 0,
      row.cessAmount ?? 0,
    ),
  );
}

export async function listSalesReturns(params: {
  companyId: string;
  query?: string;
  page?: number;
}): Promise<ReturnListResult> {
  const page = Math.max(1, params.page ?? 1);
  const query = params.query?.trim() ?? "";

  const where: Prisma.SalesReturnWhereInput = {
    companyId: params.companyId,
    ...(query.length >= 1
      ? {
          OR: [
            {
              returnNumber: {
                contains: query,
                mode: Prisma.QueryMode.insensitive,
              },
            },
            {
              sale: {
                invoiceNumber: {
                  contains: query,
                  mode: Prisma.QueryMode.insensitive,
                },
              },
            },
            {
              customer: {
                name: { contains: query, mode: Prisma.QueryMode.insensitive },
              },
            },
          ],
        }
      : {}),
  };

  const [total, rows, totals] = await Promise.all([
    prisma.salesReturn.count({ where }),
    prisma.salesReturn.findMany({
      where,
      select: {
        id: true,
        returnNumber: true,
        returnDate: true,
        reason: true,
        taxableAmount: true,
        cgstAmount: true,
        sgstAmount: true,
        igstAmount: true,
        cessAmount: true,
        totalAmount: true,
        sale: { select: { invoiceNumber: true } },
        customer: { select: { name: true } },
      },
      orderBy: [{ returnDate: "desc" }, { returnNumber: "desc" }],
      skip: (page - 1) * RETURN_PAGE_SIZE,
      take: RETURN_PAGE_SIZE,
    }),
    prisma.salesReturn.aggregate({
      where: { ...where, status: "POSTED" },
      _sum: { totalAmount: true, taxableAmount: true },
    }),
  ]);

  return {
    kind: "sales",
    rows: rows.map((row) => ({
      id: row.id,
      returnNumber: row.returnNumber,
      returnDate: row.returnDate,
      againstNumber: row.sale?.invoiceNumber ?? null,
      partyName: row.customer?.name ?? "Counter sale",
      reason: row.reason,
      taxableAmount: toStorageString(row.taxableAmount),
      taxAmount: taxOf(row),
      totalAmount: toStorageString(row.totalAmount),
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / RETURN_PAGE_SIZE)),
    postedTotal: toStorageString(totals._sum.totalAmount ?? 0),
    postedTaxable: toStorageString(totals._sum.taxableAmount ?? 0),
  };
}

export async function listPurchaseReturns(params: {
  companyId: string;
  query?: string;
  page?: number;
}): Promise<ReturnListResult> {
  const page = Math.max(1, params.page ?? 1);
  const query = params.query?.trim() ?? "";

  const where: Prisma.PurchaseReturnWhereInput = {
    companyId: params.companyId,
    ...(query.length >= 1
      ? {
          OR: [
            {
              returnNumber: {
                contains: query,
                mode: Prisma.QueryMode.insensitive,
              },
            },
            {
              purchase: {
                billNumber: {
                  contains: query,
                  mode: Prisma.QueryMode.insensitive,
                },
              },
            },
            {
              supplier: {
                name: { contains: query, mode: Prisma.QueryMode.insensitive },
              },
            },
          ],
        }
      : {}),
  };

  const [total, rows, totals] = await Promise.all([
    prisma.purchaseReturn.count({ where }),
    prisma.purchaseReturn.findMany({
      where,
      select: {
        id: true,
        returnNumber: true,
        returnDate: true,
        reason: true,
        taxableAmount: true,
        cgstAmount: true,
        sgstAmount: true,
        igstAmount: true,
        cessAmount: true,
        totalAmount: true,
        purchase: { select: { billNumber: true } },
        supplier: { select: { name: true } },
      },
      orderBy: [{ returnDate: "desc" }, { returnNumber: "desc" }],
      skip: (page - 1) * RETURN_PAGE_SIZE,
      take: RETURN_PAGE_SIZE,
    }),
    prisma.purchaseReturn.aggregate({
      where: { ...where, status: "POSTED" },
      _sum: { totalAmount: true, taxableAmount: true },
    }),
  ]);

  return {
    kind: "purchase",
    rows: rows.map((row) => ({
      id: row.id,
      returnNumber: row.returnNumber,
      returnDate: row.returnDate,
      againstNumber: row.purchase?.billNumber ?? null,
      partyName: row.supplier?.name ?? "Supplier",
      reason: row.reason,
      taxableAmount: toStorageString(row.taxableAmount),
      taxAmount: taxOf(row),
      totalAmount: toStorageString(row.totalAmount),
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / RETURN_PAGE_SIZE)),
    postedTotal: toStorageString(totals._sum.totalAmount ?? 0),
    postedTaxable: toStorageString(totals._sum.taxableAmount ?? 0),
  };
}

export type ReturnItemView = {
  lineNumber: number;
  productName: string;
  sku: string;
  quantity: string;
  rate: string;
  taxableAmount: string;
  taxPercent: string;
  taxAmount: string;
  lineTotal: string;
};

export type ReturnEntryView = {
  entryNumber: string;
  status: string;
  totalDebit: string;
  lines: Array<{
    lineNumber: number;
    accountCode: string;
    accountName: string;
    debit: string;
    credit: string;
    narration: string | null;
  }>;
};

export type ReturnDetail = {
  kind: ReturnKind;
  id: string;
  returnNumber: string;
  returnDate: Date;
  status: string;
  reason: string | null;
  partyName: string;
  partyGstin: string | null;
  against: { id: string; number: string; date: Date } | null;
  taxableAmount: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  cessAmount: string;
  /** The fraction between the exact value and the rupee it is billed at. */
  roundOff: string;
  totalAmount: string;
  /** Sales only: what the goods cost, put back into stock. */
  costReturned: string | null;
  items: ReturnItemView[];
  entry: ReturnEntryView | null;
};

/** Item rows carry a product id and no relation, so names are looked up here. */
async function productNames(
  companyId: string,
  ids: readonly string[],
): Promise<Map<string, { name: string; sku: string }>> {
  if (ids.length === 0) return new Map();
  const products = await prisma.product.findMany({
    where: { companyId, id: { in: [...new Set(ids)] } },
    select: { id: true, name: true, sku: true },
  });
  return new Map(
    products.map((product) => [
      product.id,
      { name: product.name, sku: product.sku },
    ]),
  );
}

type RawItem = {
  lineNumber: number;
  productId: string;
  quantity: Prisma.Decimal;
  rate: Prisma.Decimal;
  taxableAmount: Prisma.Decimal;
  taxPercent: Prisma.Decimal;
  cgstAmount: Prisma.Decimal;
  sgstAmount: Prisma.Decimal;
  igstAmount: Prisma.Decimal;
  cessAmount: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
};

function viewItems(
  items: readonly RawItem[],
  names: Map<string, { name: string; sku: string }>,
): ReturnItemView[] {
  return items.map((item) => {
    const product = names.get(item.productId);
    return {
      lineNumber: item.lineNumber,
      productName: product?.name ?? "Deleted product",
      sku: product?.sku ?? "—",
      quantity: toStorageString(item.quantity),
      rate: toStorageString(item.rate),
      taxableAmount: toStorageString(item.taxableAmount),
      taxPercent: toStorageString(item.taxPercent),
      taxAmount: taxOf(item),
      lineTotal: toStorageString(item.lineTotal),
    };
  });
}

const ITEM_FIELDS = {
  lineNumber: true,
  productId: true,
  quantity: true,
  rate: true,
  taxableAmount: true,
  taxPercent: true,
  cgstAmount: true,
  sgstAmount: true,
  igstAmount: true,
  cessAmount: true,
  lineTotal: true,
} as const;

async function loadEntry(
  companyId: string,
  journalEntryId: string | null,
): Promise<ReturnEntryView | null> {
  if (!journalEntryId) return null;
  const entry = await prisma.journalEntry.findFirst({
    where: { id: journalEntryId, companyId },
    select: {
      entryNumber: true,
      status: true,
      totalDebit: true,
      lines: {
        select: {
          lineNumber: true,
          debit: true,
          credit: true,
          narration: true,
          account: { select: { code: true, name: true } },
        },
        orderBy: { lineNumber: "asc" },
      },
    },
  });
  if (!entry) return null;

  return {
    entryNumber: entry.entryNumber,
    status: entry.status,
    totalDebit: toStorageString(entry.totalDebit),
    lines: entry.lines.map((line) => ({
      lineNumber: line.lineNumber,
      accountCode: line.account.code,
      accountName: line.account.name,
      debit: toStorageString(line.debit),
      credit: toStorageString(line.credit),
      narration: line.narration,
    })),
  };
}

export async function getSalesReturn(params: {
  companyId: string;
  id: string;
}): Promise<ReturnDetail> {
  const record = await prisma.salesReturn.findFirst({
    where: { id: params.id, companyId: params.companyId },
    select: {
      id: true,
      returnNumber: true,
      returnDate: true,
      status: true,
      reason: true,
      taxableAmount: true,
      cgstAmount: true,
      sgstAmount: true,
      igstAmount: true,
      cessAmount: true,
      roundOff: true,
      totalAmount: true,
      costOfGoodsReturned: true,
      journalEntryId: true,
      sale: { select: { id: true, invoiceNumber: true, invoiceDate: true } },
      customer: { select: { name: true, gstin: true } },
      items: { select: ITEM_FIELDS, orderBy: { lineNumber: "asc" } },
    },
  });

  if (!record) {
    throw new MasterDataError(
      "That credit note could not be found.",
      "NOT_FOUND",
    );
  }

  const [names, entry] = await Promise.all([
    productNames(
      params.companyId,
      record.items.map((item) => item.productId),
    ),
    loadEntry(params.companyId, record.journalEntryId),
  ]);

  return {
    kind: "sales",
    id: record.id,
    returnNumber: record.returnNumber,
    returnDate: record.returnDate,
    status: record.status,
    reason: record.reason,
    partyName: record.customer?.name ?? "Counter sale",
    partyGstin: record.customer?.gstin ?? null,
    against: record.sale
      ? {
          id: record.sale.id,
          number: record.sale.invoiceNumber,
          date: record.sale.invoiceDate,
        }
      : null,
    taxableAmount: toStorageString(record.taxableAmount),
    cgstAmount: toStorageString(record.cgstAmount),
    sgstAmount: toStorageString(record.sgstAmount),
    igstAmount: toStorageString(record.igstAmount),
    cessAmount: toStorageString(record.cessAmount),
    roundOff: toStorageString(record.roundOff),
    totalAmount: toStorageString(record.totalAmount),
    costReturned: toStorageString(record.costOfGoodsReturned),
    items: viewItems(record.items, names),
    entry,
  };
}

export async function getPurchaseReturn(params: {
  companyId: string;
  id: string;
}): Promise<ReturnDetail> {
  const record = await prisma.purchaseReturn.findFirst({
    where: { id: params.id, companyId: params.companyId },
    select: {
      id: true,
      returnNumber: true,
      returnDate: true,
      status: true,
      reason: true,
      taxableAmount: true,
      cgstAmount: true,
      sgstAmount: true,
      igstAmount: true,
      cessAmount: true,
      roundOff: true,
      totalAmount: true,
      journalEntryId: true,
      purchase: { select: { id: true, billNumber: true, billDate: true } },
      supplier: { select: { name: true, gstin: true } },
      items: { select: ITEM_FIELDS, orderBy: { lineNumber: "asc" } },
    },
  });

  if (!record) {
    throw new MasterDataError(
      "That debit note could not be found.",
      "NOT_FOUND",
    );
  }

  const [names, entry] = await Promise.all([
    productNames(
      params.companyId,
      record.items.map((item) => item.productId),
    ),
    loadEntry(params.companyId, record.journalEntryId),
  ]);

  return {
    kind: "purchase",
    id: record.id,
    returnNumber: record.returnNumber,
    returnDate: record.returnDate,
    status: record.status,
    reason: record.reason,
    partyName: record.supplier?.name ?? "Supplier",
    partyGstin: record.supplier?.gstin ?? null,
    against: record.purchase
      ? {
          id: record.purchase.id,
          number: record.purchase.billNumber,
          date: record.purchase.billDate,
        }
      : null,
    taxableAmount: toStorageString(record.taxableAmount),
    cgstAmount: toStorageString(record.cgstAmount),
    sgstAmount: toStorageString(record.sgstAmount),
    igstAmount: toStorageString(record.igstAmount),
    cessAmount: toStorageString(record.cessAmount),
    roundOff: toStorageString(record.roundOff),
    totalAmount: toStorageString(record.totalAmount),
    costReturned: null,
    items: viewItems(record.items, names),
    entry,
  };
}

export type ReturnSummary = {
  id: string;
  returnNumber: string;
  returnDate: Date;
  totalAmount: string;
  reason: string | null;
};

/** Returns already raised against one invoice, newest first. */
export async function salesReturnsAgainst(params: {
  companyId: string;
  saleId: string;
}): Promise<{ rows: ReturnSummary[]; total: string }> {
  const rows = await prisma.salesReturn.findMany({
    where: {
      companyId: params.companyId,
      saleId: params.saleId,
      status: "POSTED",
    },
    select: {
      id: true,
      returnNumber: true,
      returnDate: true,
      totalAmount: true,
      reason: true,
    },
    orderBy: { returnDate: "desc" },
  });

  return {
    rows: rows.map((row) => ({ ...row, totalAmount: String(row.totalAmount) })),
    total: toStorageString(
      rows.reduce((sum, row) => add(sum, row.totalAmount), money(0)),
    ),
  };
}

/** Returns already raised against one bill, newest first. */
export async function purchaseReturnsAgainst(params: {
  companyId: string;
  purchaseId: string;
}): Promise<{ rows: ReturnSummary[]; total: string }> {
  const rows = await prisma.purchaseReturn.findMany({
    where: {
      companyId: params.companyId,
      purchaseId: params.purchaseId,
      status: "POSTED",
    },
    select: {
      id: true,
      returnNumber: true,
      returnDate: true,
      totalAmount: true,
      reason: true,
    },
    orderBy: { returnDate: "desc" },
  });

  return {
    rows: rows.map((row) => ({ ...row, totalAmount: String(row.totalAmount) })),
    total: toStorageString(
      rows.reduce((sum, row) => add(sum, row.totalAmount), money(0)),
    ),
  };
}
