import "server-only";
import { Prisma, StockMovementType } from "@prisma/client";
import { prisma, type DbClient } from "@/lib/db";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { isZero, sum, toStorageString } from "@/lib/money";
import type { ProductInput } from "@/lib/validation/master-data";
import { recordAuditLog } from "@/server/audit/audit-log";
import { MasterDataError } from "./errors";
import {
  OPENING_SOURCE,
  openingStockValue,
  postOpeningDelta,
  resolveOpeningContext,
  resolveSystemAccountId,
} from "./opening-balance";

/**
 * Products and services.
 *
 * Creating a product with opening stock does three things at once, and all
 * three or none: it writes the product, it opens the stock ledger for it, and
 * it posts the value of that stock to Inventory against the owner's capital.
 * Stock sitting on a shelf that the balance sheet does not know about is the
 * single most common way a retailer's books stop matching their business.
 */

export const PRODUCT_AUDIT = {
  CREATED: "product.created",
  UPDATED: "product.updated",
  ARCHIVED: "product.archived",
  RESTORED: "product.restored",
} as const;

export const PRODUCT_PAGE_SIZE = 25;

export type ProductRow = {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  hsnCode: string | null;
  categoryId: string | null;
  categoryName: string | null;
  unitId: string;
  unitCode: string;
  taxRateId: string | null;
  taxRateLabel: string | null;
  purchasePrice: string;
  sellingPrice: string;
  mrp: string;
  isStockTracked: boolean;
  openingQuantity: string;
  openingRate: string;
  minStockLevel: string;
  /** Live stock across branches. Null when the product is not tracked. */
  stockOnHand: string | null;
  description: string | null;
  isArchived: boolean;
};

export type ProductListResult = {
  rows: ProductRow[];
  total: number;
  page: number;
  pageCount: number;
};

export async function listProducts(params: {
  companyId: string;
  query?: string;
  categoryId?: string;
  includeArchived?: boolean;
  page?: number;
}): Promise<ProductListResult> {
  const page = Math.max(1, params.page ?? 1);
  const query = params.query?.trim() ?? "";

  const where: Prisma.ProductWhereInput = {
    companyId: params.companyId,
    ...(params.includeArchived ? {} : { archivedAt: null }),
    ...(params.categoryId ? { categoryId: params.categoryId } : {}),
    ...(query.length >= 1
      ? {
          OR: [
            { name: { contains: query, mode: Prisma.QueryMode.insensitive } },
            { sku: { contains: query, mode: Prisma.QueryMode.insensitive } },
            { barcode: { contains: query } },
            { hsnCode: { contains: query } },
          ],
        }
      : {}),
  };

  const [total, products] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      select: {
        id: true,
        sku: true,
        name: true,
        description: true,
        barcode: true,
        hsnCode: true,
        categoryId: true,
        category: { select: { name: true } },
        unitId: true,
        unit: { select: { code: true } },
        taxRateId: true,
        taxRate: { select: { code: true, ratePercent: true } },
        purchasePrice: true,
        sellingPrice: true,
        mrp: true,
        isStockTracked: true,
        openingQuantity: true,
        openingRate: true,
        minStockLevel: true,
        archivedAt: true,
        inventoryBalances: { select: { quantity: true } },
      },
      // Broken by SKU, which is unique per company. Names are not: a shop
      // carrying two kinds of "Sugar" has two rows the database may return
      // in either order, and OFFSET paging over an order that can change
      // between two page loads shows one product twice and loses another.
      orderBy: [{ name: "asc" }, { sku: "asc" }],
      skip: (page - 1) * PRODUCT_PAGE_SIZE,
      take: PRODUCT_PAGE_SIZE,
    }),
  ]);

  return {
    rows: products.map((product) => ({
      id: product.id,
      sku: product.sku,
      name: product.name,
      description: product.description,
      barcode: product.barcode,
      hsnCode: product.hsnCode,
      categoryId: product.categoryId,
      categoryName: product.category?.name ?? null,
      unitId: product.unitId,
      unitCode: product.unit.code,
      taxRateId: product.taxRateId,
      taxRateLabel: product.taxRate
        ? `${Number(product.taxRate.ratePercent)}%`
        : null,
      purchasePrice: toStorageString(product.purchasePrice),
      sellingPrice: toStorageString(product.sellingPrice),
      mrp: toStorageString(product.mrp ?? 0),
      isStockTracked: product.isStockTracked,
      openingQuantity: toStorageString(product.openingQuantity),
      openingRate: toStorageString(product.openingRate),
      minStockLevel: toStorageString(product.minStockLevel),
      stockOnHand: product.isStockTracked
        ? toStorageString(
            sum(product.inventoryBalances.map((balance) => balance.quantity)),
          )
        : null,
      isArchived: product.archivedAt !== null,
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PRODUCT_PAGE_SIZE)),
  };
}

async function assertSkuIsFree(
  tx: DbClient,
  companyId: string,
  sku: string,
  excludeId?: string,
): Promise<void> {
  const existing = await tx.product.findFirst({
    where: { companyId, sku, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, archivedAt: true },
  });
  if (existing) {
    throw new MasterDataError(
      existing.archivedAt
        ? `The code ${sku} belongs to an archived product. Restore it instead of creating a duplicate.`
        : `A product with the code ${sku} already exists.`,
      "DUPLICATE_SKU",
      "sku",
    );
  }
}

/** Verifies every referenced record belongs to this tenant before it is used. */
async function resolveReferences(
  tx: DbClient,
  companyId: string,
  input: ProductInput,
): Promise<{
  unitId: string;
  categoryId: string | null;
  taxRateId: string | null;
}> {
  const [unit, category, taxRate] = await Promise.all([
    tx.unit.findFirst({
      where: { id: input.unitId, companyId },
      select: { id: true },
    }),
    input.categoryId
      ? tx.category.findFirst({
          where: { id: input.categoryId, companyId },
          select: { id: true },
        })
      : Promise.resolve(null),
    input.taxRateId
      ? tx.taxRate.findFirst({
          where: { id: input.taxRateId, companyId },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);

  if (!unit) {
    throw new MasterDataError(
      "That unit of measure could not be found.",
      "NOT_FOUND",
      "unitId",
    );
  }
  // An id that names another tenant's category resolves to nothing here, so it
  // is simply dropped rather than silently linking across companies.
  if (input.categoryId && !category) {
    throw new MasterDataError(
      "That category could not be found.",
      "NOT_FOUND",
      "categoryId",
    );
  }
  if (input.taxRateId && !taxRate) {
    throw new MasterDataError(
      "That tax rate could not be found.",
      "NOT_FOUND",
      "taxRateId",
    );
  }

  return {
    unitId: unit.id,
    categoryId: category?.id ?? null,
    taxRateId: taxRate?.id ?? null,
  };
}

function toRecordData(input: ProductInput) {
  return {
    sku: input.sku,
    name: input.name,
    description: input.description || null,
    barcode: input.barcode || null,
    hsnCode: input.hsnCode || null,
    purchasePrice: toStorageString(input.purchasePrice),
    sellingPrice: toStorageString(input.sellingPrice),
    mrp: input.mrp > 0 ? toStorageString(input.mrp) : null,
    minStockLevel: toStorageString(input.minStockLevel),
    isStockTracked: input.isStockTracked,
  };
}

export async function createProduct(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  input: ProductInput;
}): Promise<{
  id: string;
  sku: string;
  openingEntry: string | null;
  /** See the same field on `createParty`. */
  openingDeferredTo: string | null;
}> {
  return prisma.$transaction(async (tx) => {
    await assertSkuIsFree(tx, params.companyId, params.input.sku);
    const references = await resolveReferences(
      tx,
      params.companyId,
      params.input,
    );

    const stockValue = params.input.isStockTracked
      ? openingStockValue(
          params.input.openingQuantity,
          params.input.openingRate,
        )
      : openingStockValue(0, 0);

    const product = await tx.product.create({
      data: {
        ...toRecordData(params.input),
        companyId: params.companyId,
        unitId: references.unitId,
        categoryId: references.categoryId,
        taxRateId: references.taxRateId,
        openingQuantity: params.input.isStockTracked
          ? toStorageString(params.input.openingQuantity)
          : "0",
        openingRate: params.input.isStockTracked
          ? toStorageString(params.input.openingRate)
          : "0",
      },
      select: { id: true, sku: true },
    });

    let openingEntry: string | null = null;
    let openingDeferredTo: string | null = null;

    if (!isZero(stockValue)) {
      const opening = await resolveOpeningContext(tx, params.companyId);
      const inventoryAccountId = await resolveSystemAccountId(
        tx,
        params.companyId,
        SYSTEM_ACCOUNT.INVENTORY,
      );

      if (!opening.branchId) {
        throw new MasterDataError(
          "This business has no primary branch, so opening stock has nowhere to sit.",
          "NO_BRANCH",
        );
      }

      await tx.inventoryBalance.create({
        data: {
          companyId: params.companyId,
          productId: product.id,
          branchId: opening.branchId,
          quantity: toStorageString(params.input.openingQuantity),
          averageCost: toStorageString(params.input.openingRate),
          stockValue: toStorageString(stockValue),
          lastMovementAt: opening.date,
        },
      });

      // The stock ledger starts with an explicit opening row so a position is
      // always reconstructable from movements alone.
      await tx.inventoryMovement.create({
        data: {
          companyId: params.companyId,
          productId: product.id,
          branchId: opening.branchId,
          movementType: StockMovementType.OPENING,
          movementDate: opening.date,
          quantity: toStorageString(params.input.openingQuantity),
          unitCost: toStorageString(params.input.openingRate),
          value: toStorageString(stockValue),
          balanceQuantity: toStorageString(params.input.openingQuantity),
          balanceValue: toStorageString(stockValue),
          sourceType: OPENING_SOURCE.PRODUCT,
          sourceId: product.id,
          notes: "Opening stock",
        },
      });

      const entry = await postOpeningDelta(tx, {
        companyId: params.companyId,
        context: opening,
        accountId: inventoryAccountId,
        source: OPENING_SOURCE.PRODUCT,
        sourceId: product.id,
        target: stockValue,
        posted: 0,
        narration: `Opening stock — ${params.input.name}`,
        createdById: params.userId,
      });
      openingEntry = entry?.entryNumber ?? null;
      openingDeferredTo =
        opening.deferred && entry
          ? opening.date.toISOString().slice(0, 10)
          : null;
    }

    await recordAuditLog(
      {
        action: PRODUCT_AUDIT.CREATED,
        module: "Inventory",
        companyId: params.companyId,
        userId: params.userId,
        actorEmail: params.actorEmail,
        entityType: "Product",
        entityId: product.id,
        metadata: {
          sku: product.sku,
          name: params.input.name,
          openingQuantity: toStorageString(params.input.openingQuantity),
          openingValue: toStorageString(stockValue),
          openingEntry,
        },
      },
      tx,
    );

    return {
      id: product.id,
      sku: product.sku,
      openingEntry,
      openingDeferredTo,
    };
  });
}

/**
 * Updates a product's details. Opening stock is deliberately not among them.
 *
 * Opening stock is a quantity *and* a value, tied to a movement in the stock
 * ledger and a line in the journal. Correcting it properly means a stock
 * adjustment, which is a real transaction with its own date and reason — that
 * arrives with the Inventory module. Letting this form quietly rewrite the
 * figure would leave the ledger and the stock card disagreeing with each other.
 */
export async function updateProduct(params: {
  companyId: string;
  productId: string;
  userId: string;
  actorEmail: string;
  input: ProductInput;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.product.findFirst({
      where: { id: params.productId, companyId: params.companyId },
      select: {
        id: true,
        sku: true,
        isStockTracked: true,
        // What it holds now, not what it was opened with. See below.
        inventoryBalances: { select: { quantity: true, stockValue: true } },
      },
    });
    if (!existing) {
      throw new MasterDataError(
        "That product could not be found.",
        "NOT_FOUND",
      );
    }

    await assertSkuIsFree(
      tx,
      params.companyId,
      params.input.sku,
      params.productId,
    );
    const references = await resolveReferences(
      tx,
      params.companyId,
      params.input,
    );

    // Turning stock tracking off on a product that already holds stock would
    // strand its value in the Inventory account with nothing to explain it —
    // the stock report drops an untracked product, the balance sheet does not.
    //
    // This asked `openingQuantity`, which is the number somebody typed when the
    // product was first set up and never moves again. It is not what the
    // product holds. A line opened at nil and stocked by purchases afterwards —
    // which is most of them — passed the check with a shelf full of goods, and
    // a line opened at five hundred and since sold down to nothing was refused
    // a change that was perfectly safe. The rule was right and it was reading
    // the wrong number.
    const onHand = sum(
      existing.inventoryBalances.map((balance) => balance.quantity),
    );
    const heldValue = sum(
      existing.inventoryBalances.map((balance) => balance.stockValue),
    );
    if (
      existing.isStockTracked &&
      !params.input.isStockTracked &&
      (!isZero(onHand) || !isZero(heldValue))
    ) {
      throw new MasterDataError(
        `This product still holds ${onHand.toFixed(3).replace(/\.?0+$/, "")} in stock, so it cannot be switched to a non-stock item. Sell it or write it off first.`,
        "HAS_STOCK",
        "isStockTracked",
      );
    }

    await tx.product.update({
      where: { id: params.productId },
      data: {
        ...toRecordData(params.input),
        unitId: references.unitId,
        categoryId: references.categoryId,
        taxRateId: references.taxRateId,
      },
    });

    await recordAuditLog(
      {
        action: PRODUCT_AUDIT.UPDATED,
        module: "Inventory",
        companyId: params.companyId,
        userId: params.userId,
        actorEmail: params.actorEmail,
        entityType: "Product",
        entityId: params.productId,
        metadata: { sku: params.input.sku, name: params.input.name },
      },
      tx,
    );
  });
}

export async function setProductArchived(params: {
  companyId: string;
  productId: string;
  archived: boolean;
  userId: string;
  actorEmail: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.product.findFirst({
      where: { id: params.productId, companyId: params.companyId },
      select: { id: true, sku: true, name: true },
    });
    if (!existing) {
      throw new MasterDataError(
        "That product could not be found.",
        "NOT_FOUND",
      );
    }

    await tx.product.update({
      where: { id: params.productId },
      data: {
        archivedAt: params.archived ? new Date() : null,
        isActive: !params.archived,
      },
    });

    await recordAuditLog(
      {
        action: params.archived
          ? PRODUCT_AUDIT.ARCHIVED
          : PRODUCT_AUDIT.RESTORED,
        module: "Inventory",
        companyId: params.companyId,
        userId: params.userId,
        actorEmail: params.actorEmail,
        entityType: "Product",
        entityId: params.productId,
        metadata: { sku: existing.sku, name: existing.name },
      },
      tx,
    );
  });
}
