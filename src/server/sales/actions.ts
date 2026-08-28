"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { toStorageString } from "@/lib/money";
import {
  saleSchema,
  voidSaleSchema,
  type SaleInput,
  type VoidSaleInput,
} from "@/lib/validation/sales";
import { logger } from "@/lib/observability/logger";
import { recordActionFailure } from "@/lib/observability/metrics";
import {
  ACTION_ERROR,
  fail,
  ok,
  zodFieldErrors,
  type ActionResult,
} from "@/server/auth/action-result";
import { billingRefusal } from "@/server/billing/guards";
import { postingBranchId } from "@/server/company/posting-branch";
import { branchQuantities } from "@/server/inventory/stock-service";
import { assertPermission } from "@/server/auth/context";
import {
  NoFiscalPeriodError,
  PeriodClosedError,
} from "@/server/accounting/post-journal-entry";
import { requireSameOrigin } from "@/server/security/request-context";
import {
  createSale,
  voidSale,
  SaleError,
  type PostedSale,
} from "./sale-service";

/**
 * Sales actions.
 *
 * The invoice form sends what was sold; it never sends what it came to. Totals,
 * tax and cost are computed on the server from products, quantities and rates,
 * so an altered request can change what is claimed to have been sold but cannot
 * change what the books say it was worth.
 */

function revalidateSales(): void {
  for (const path of [
    "/app",
    "/app/sales",
    "/app/products",
    "/app/customers",
  ]) {
    revalidatePath(path);
  }
}

function fromServiceError(error: unknown): ActionResult<never> {
  if (error instanceof SaleError) {
    return fail(error.message, {
      code: error.code,
      fieldErrors: error.field ? { [error.field]: error.message } : undefined,
    });
  }
  if (
    error instanceof PeriodClosedError ||
    error instanceof NoFiscalPeriodError
  ) {
    return fail(error.message, { code: "PERIOD_UNAVAILABLE" });
  }
  logger.error("Sales action failed", { module: "Sales", error });
  recordActionFailure("Sales", ACTION_ERROR.UNEXPECTED);
  return fail(
    "Something went wrong. Nothing was recorded — please try again.",
    { code: ACTION_ERROR.UNEXPECTED },
  );
}

export async function createSaleAction(
  input: SaleInput,
): Promise<ActionResult<PostedSale>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("sales.create");

  const refusal = await billingRefusal(context.company.id, {
    limit: "transactionsPerMonth",
  });
  if (refusal) return refusal;
  const parsed = saleSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the invoice below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const sale = await createSale({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      // A member restricted to one branch posts to that branch, whatever the
      // request says; an unrestricted member posts to the primary branch.
      branchId: context.membership.branchId,
      input: parsed.data,
    });
    revalidateSales();
    return ok(sale);
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function voidSaleAction(
  saleId: string,
  input: VoidSaleInput,
): Promise<ActionResult<{ entryNumber: string }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("sales.void");

  const refusal = await billingRefusal(context.company.id, {});
  if (refusal) return refusal;
  const parsed = voidSaleSchema.safeParse(input);
  if (!parsed.success) {
    return fail("A reason is required.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const result = await voidSale({
      companyId: context.company.id,
      saleId,
      userId: context.user.id,
      actorEmail: context.user.email,
      reason: parsed.data.reason,
    });
    revalidateSales();
    revalidatePath(`/app/sales/${saleId}`);
    return ok(result);
  } catch (error) {
    return fromServiceError(error);
  }
}

export type SellableProduct = {
  id: string;
  sku: string;
  name: string;
  unitCode: string;
  sellingPrice: string;
  taxPercent: string;
  hsnCode: string | null;
  isStockTracked: boolean;
  stockOnHand: string | null;
};

/**
 * Products the invoice form can pick from, matched on the server.
 *
 * Shipping the whole catalogue to the browser would be simpler and would also
 * hand every cashier a copy of the tenant's cost base and stock position on
 * page load. This returns the few rows a query matched, and only the fields an
 * invoice line needs.
 */
export async function searchSellableProductsAction(
  query: string,
): Promise<SellableProduct[]> {
  const context = await assertPermission("sales.create");
  const trimmed = query.trim();

  // The branch this member's invoice will post to, because that is the branch
  // whose shelf the sale will be refused against. Summing every branch told a
  // cashier at the second shop that the first shop's stock was theirs to sell.
  const branchId = await postingBranchId(prisma, {
    companyId: context.company.id,
    memberBranchId: context.membership.branchId,
  });

  const products = await prisma.product.findMany({
    where: {
      companyId: context.company.id,
      archivedAt: null,
      ...(trimmed.length >= 1
        ? {
            OR: [
              {
                name: { contains: trimmed, mode: Prisma.QueryMode.insensitive },
              },
              {
                sku: { contains: trimmed, mode: Prisma.QueryMode.insensitive },
              },
              { barcode: { contains: trimmed } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      sku: true,
      name: true,
      hsnCode: true,
      sellingPrice: true,
      isStockTracked: true,
      unit: { select: { code: true } },
      taxRate: { select: { ratePercent: true } },
    },
    orderBy: { name: "asc" },
    take: 20,
  });

  const onHand = await branchQuantities(prisma, {
    companyId: context.company.id,
    branchId,
    productIds: products.map((product) => product.id),
  });

  return products.map((product) => ({
    id: product.id,
    sku: product.sku,
    name: product.name,
    unitCode: product.unit.code,
    sellingPrice: toStorageString(product.sellingPrice),
    taxPercent: toStorageString(product.taxRate?.ratePercent ?? 0),
    hsnCode: product.hsnCode,
    isStockTracked: product.isStockTracked,
    stockOnHand: product.isStockTracked
      ? toStorageString(onHand.get(product.id) ?? 0)
      : null,
  }));
}
