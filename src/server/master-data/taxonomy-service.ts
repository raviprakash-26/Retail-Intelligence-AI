import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { CategoryInput, UnitInput } from "@/lib/validation/master-data";
import { recordAuditLog } from "@/server/audit/audit-log";
import { MasterDataError } from "./errors";

/**
 * Categories, units of measure and the tax rates products are priced against.
 *
 * All three are pickers on the product form, so they are read together and
 * cached as one shape. Only the first two are editable here — tax rates are
 * versioned records the GST module owns, and letting a product form rewrite the
 * rate that historical invoices were calculated at would make those invoices
 * irreproducible.
 */

export const TAXONOMY_AUDIT = {
  CATEGORY_CREATED: "category.created",
  CATEGORY_UPDATED: "category.updated",
  CATEGORY_ARCHIVED: "category.archived",
  UNIT_CREATED: "unit.created",
  UNIT_UPDATED: "unit.updated",
} as const;

export type CategoryOption = {
  id: string;
  name: string;
  parentId: string | null;
  productCount: number;
  isActive: boolean;
};

export type UnitOption = {
  id: string;
  code: string;
  name: string;
  precision: number;
  productCount: number;
};

export type TaxRateOption = {
  id: string;
  code: string;
  name: string;
  ratePercent: string;
};

export type ProductTaxonomy = {
  categories: CategoryOption[];
  units: UnitOption[];
  taxRates: TaxRateOption[];
};

export async function getProductTaxonomy(
  companyId: string,
): Promise<ProductTaxonomy> {
  const [categories, units, taxRates] = await Promise.all([
    prisma.category.findMany({
      where: { companyId, archivedAt: null },
      select: {
        id: true,
        name: true,
        parentId: true,
        isActive: true,
        _count: { select: { products: true } },
      },
      orderBy: { name: "asc" },
    }),
    prisma.unit.findMany({
      where: { companyId, isActive: true },
      select: {
        id: true,
        code: true,
        name: true,
        precision: true,
        _count: { select: { products: true } },
      },
      orderBy: { code: "asc" },
    }),
    prisma.taxRate.findMany({
      where: { companyId, isActive: true },
      select: { id: true, code: true, name: true, ratePercent: true },
      orderBy: { ratePercent: "asc" },
    }),
  ]);

  return {
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      parentId: category.parentId,
      productCount: category._count.products,
      isActive: category.isActive,
    })),
    units: units.map((unit) => ({
      id: unit.id,
      code: unit.code,
      name: unit.name,
      precision: unit.precision,
      productCount: unit._count.products,
    })),
    taxRates: taxRates.map((rate) => ({
      id: rate.id,
      code: rate.code,
      name: rate.name,
      ratePercent: rate.ratePercent.toFixed(2),
    })),
  };
}

export async function createCategory(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  input: CategoryInput;
}): Promise<{ id: string }> {
  const duplicate = await prisma.category.findFirst({
    where: {
      companyId: params.companyId,
      name: { equals: params.input.name, mode: Prisma.QueryMode.insensitive },
    },
    select: { id: true },
  });
  if (duplicate) {
    throw new MasterDataError(
      `A category named "${params.input.name}" already exists.`,
      "DUPLICATE_NAME",
      "name",
    );
  }

  // A parent from another tenant resolves to nothing, so the reference is
  // dropped rather than crossing the company boundary.
  const parent = params.input.parentId
    ? await prisma.category.findFirst({
        where: { id: params.input.parentId, companyId: params.companyId },
        select: { id: true },
      })
    : null;

  const category = await prisma.category.create({
    data: {
      companyId: params.companyId,
      name: params.input.name,
      description: params.input.description || null,
      parentId: parent?.id ?? null,
    },
    select: { id: true },
  });

  await recordAuditLog({
    action: TAXONOMY_AUDIT.CATEGORY_CREATED,
    module: "Inventory",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "Category",
    entityId: category.id,
    metadata: { name: params.input.name },
  });

  return category;
}

export async function updateCategory(params: {
  companyId: string;
  categoryId: string;
  userId: string;
  actorEmail: string;
  input: CategoryInput;
}): Promise<void> {
  const existing = await prisma.category.findFirst({
    where: { id: params.categoryId, companyId: params.companyId },
    select: { id: true },
  });
  if (!existing) {
    throw new MasterDataError("That category could not be found.", "NOT_FOUND");
  }

  const duplicate = await prisma.category.findFirst({
    where: {
      companyId: params.companyId,
      id: { not: params.categoryId },
      name: { equals: params.input.name, mode: Prisma.QueryMode.insensitive },
    },
    select: { id: true },
  });
  if (duplicate) {
    throw new MasterDataError(
      `A category named "${params.input.name}" already exists.`,
      "DUPLICATE_NAME",
      "name",
    );
  }

  // A category that is its own ancestor makes the tree infinite.
  if (params.input.parentId === params.categoryId) {
    throw new MasterDataError(
      "A category cannot sit inside itself.",
      "CYCLE",
      "parentId",
    );
  }

  await prisma.category.update({
    where: { id: params.categoryId },
    data: {
      name: params.input.name,
      description: params.input.description || null,
      parentId: params.input.parentId || null,
    },
  });

  await recordAuditLog({
    action: TAXONOMY_AUDIT.CATEGORY_UPDATED,
    module: "Inventory",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "Category",
    entityId: params.categoryId,
    metadata: { name: params.input.name },
  });
}

/**
 * Archives a category. Products keep their link so an archived category still
 * explains what an old product was filed under.
 */
export async function archiveCategory(params: {
  companyId: string;
  categoryId: string;
  userId: string;
  actorEmail: string;
}): Promise<void> {
  const existing = await prisma.category.findFirst({
    where: { id: params.categoryId, companyId: params.companyId },
    select: { id: true, name: true, _count: { select: { children: true } } },
  });
  if (!existing) {
    throw new MasterDataError("That category could not be found.", "NOT_FOUND");
  }
  if (existing._count.children > 0) {
    throw new MasterDataError(
      "This category has sub-categories. Move or archive those first.",
      "HAS_CHILDREN",
    );
  }

  await prisma.category.update({
    where: { id: params.categoryId },
    data: { archivedAt: new Date(), isActive: false },
  });

  await recordAuditLog({
    action: TAXONOMY_AUDIT.CATEGORY_ARCHIVED,
    module: "Inventory",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "Category",
    entityId: params.categoryId,
    metadata: { name: existing.name },
  });
}

export async function createUnit(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  input: UnitInput;
}): Promise<{ id: string }> {
  const duplicate = await prisma.unit.findUnique({
    where: {
      companyId_code: { companyId: params.companyId, code: params.input.code },
    },
    select: { id: true },
  });
  if (duplicate) {
    throw new MasterDataError(
      `A unit with the code ${params.input.code} already exists.`,
      "DUPLICATE_CODE",
      "code",
    );
  }

  const unit = await prisma.unit.create({
    data: {
      companyId: params.companyId,
      code: params.input.code,
      name: params.input.name,
      precision: params.input.precision,
    },
    select: { id: true },
  });

  await recordAuditLog({
    action: TAXONOMY_AUDIT.UNIT_CREATED,
    module: "Inventory",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "Unit",
    entityId: unit.id,
    metadata: { code: params.input.code, name: params.input.name },
  });

  return unit;
}

/**
 * Renames a unit, and only renames it.
 *
 * Precision is fixed once products use the unit: changing "pieces" from 0 to 3
 * decimal places would not convert anything, it would only change how existing
 * quantities are read — and a stock figure that means something different than
 * it did yesterday is worse than one that cannot be edited.
 */
export async function updateUnit(params: {
  companyId: string;
  unitId: string;
  userId: string;
  actorEmail: string;
  input: UnitInput;
}): Promise<{ precisionLocked: boolean }> {
  const existing = await prisma.unit.findFirst({
    where: { id: params.unitId, companyId: params.companyId },
    select: {
      id: true,
      code: true,
      precision: true,
      _count: { select: { products: true } },
    },
  });
  if (!existing) {
    throw new MasterDataError("That unit could not be found.", "NOT_FOUND");
  }

  if (existing.code !== params.input.code) {
    const duplicate = await prisma.unit.findUnique({
      where: {
        companyId_code: { companyId: params.companyId, code: params.input.code },
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new MasterDataError(
        `A unit with the code ${params.input.code} already exists.`,
        "DUPLICATE_CODE",
        "code",
      );
    }
  }

  const precisionLocked = existing._count.products > 0;

  await prisma.unit.update({
    where: { id: params.unitId },
    data: {
      code: params.input.code,
      name: params.input.name,
      precision: precisionLocked ? existing.precision : params.input.precision,
    },
  });

  await recordAuditLog({
    action: TAXONOMY_AUDIT.UNIT_UPDATED,
    module: "Inventory",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "Unit",
    entityId: params.unitId,
    metadata: {
      code: params.input.code,
      name: params.input.name,
      precisionLocked,
    },
  });

  return { precisionLocked };
}
