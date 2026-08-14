"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { InventoryMethod } from "@/lib/inventory/valuation";
import {
  stockAdjustmentSchema,
  type StockAdjustmentInput,
} from "@/lib/validation/inventory";
import {
  ACTION_ERROR,
  fail,
  ok,
  zodFieldErrors,
  type ActionResult,
} from "@/server/auth/action-result";
import { billingRefusal } from "@/server/billing/guards";
import { assertPermission } from "@/server/auth/context";
import {
  NoFiscalPeriodError,
  PeriodClosedError,
} from "@/server/accounting/post-journal-entry";
import { MissingAccountError } from "@/server/documents/accounts";
import { requireSameOrigin } from "@/server/security/request-context";
import {
  createStockAdjustment,
  readBookQuantity,
  StockAdjustmentError,
  type PostedAdjustment,
} from "./adjustment-service";

/**
 * Stock adjustment actions.
 *
 * Adjusting stock writes off value, so it needs `inventory.adjust` — a
 * permission the cashier template does not carry. Someone who can silently
 * reduce stock can conceal what they have taken.
 */

function revalidateInventory(): void {
  for (const path of ["/app", "/app/inventory", "/app/products"]) {
    revalidatePath(path);
  }
}

export async function createStockAdjustmentAction(
  input: StockAdjustmentInput,
): Promise<ActionResult<PostedAdjustment>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("inventory.adjust");

  const refusal = await billingRefusal(context.company.id, {});
  if (refusal) return refusal;
  const parsed = stockAdjustmentSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const adjustment = await createStockAdjustment({
      companyId: context.company.id,
      branchId: context.membership.branchId,
      userId: context.user.id,
      actorEmail: context.user.email,
      input: parsed.data,
    });
    revalidateInventory();
    return ok(adjustment);
  } catch (error) {
    if (error instanceof StockAdjustmentError) {
      return fail(error.message, {
        code: error.code,
        fieldErrors: error.field ? { [error.field]: error.message } : undefined,
      });
    }
    if (error instanceof MissingAccountError) {
      return fail(error.message, { code: "NO_ACCOUNT" });
    }
    if (
      error instanceof PeriodClosedError ||
      error instanceof NoFiscalPeriodError
    ) {
      return fail(error.message, { code: "PERIOD_UNAVAILABLE" });
    }
    console.error("Stock adjustment failed", error);
    return fail(
      "Something went wrong. Nothing was changed — please try again.",
      { code: ACTION_ERROR.UNEXPECTED },
    );
  }
}

/**
 * What the books say a product holds right now.
 *
 * Fetched when a product is chosen so the form can show the figure beside the
 * box the count goes in — an adjustment entered without seeing what it is being
 * compared against is a guess.
 */
export async function bookQuantityAction(
  productId: string,
): Promise<{ quantity: string; averageCost: string; stockValue: string }> {
  const context = await assertPermission("inventory.adjust");
  const [company, primary] = await Promise.all([
    prisma.company.findUniqueOrThrow({
      where: { id: context.company.id },
      select: { inventoryMethod: true },
    }),
    prisma.branch.findFirst({
      where: { companyId: context.company.id, isPrimary: true },
      select: { id: true },
    }),
  ]);

  // The same branch the adjustment will post against, so the figure shown
  // beside the count box is the one it will be compared with.
  return readBookQuantity({
    companyId: context.company.id,
    productId,
    branchId: context.membership.branchId ?? primary?.id ?? null,
    method: company.inventoryMethod as InventoryMethod,
  });
}

/** Stock-tracked products, for the adjustment form's picker. */
export async function adjustableProductsAction(): Promise<
  Array<{ id: string; sku: string; name: string; unitCode: string }>
> {
  const context = await assertPermission("inventory.adjust");
  const products = await prisma.product.findMany({
    where: {
      companyId: context.company.id,
      isStockTracked: true,
      archivedAt: null,
    },
    select: {
      id: true,
      sku: true,
      name: true,
      unit: { select: { code: true } },
    },
    orderBy: { name: "asc" },
    take: 500,
  });

  return products.map((product) => ({
    id: product.id,
    sku: product.sku,
    name: product.name,
    unitCode: product.unit.code,
  }));
}
