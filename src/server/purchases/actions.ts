"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { toStorageString } from "@/lib/money";
import {
  purchaseSchema,
  voidPurchaseSchema,
  type PurchaseInput,
  type VoidPurchaseInput,
} from "@/lib/validation/purchases";
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
import {
  getRequestContext,
  isSameOrigin,
} from "@/server/security/request-context";
import {
  createPurchase,
  voidPurchase,
  PurchaseError,
  type PostedPurchase,
} from "./purchase-service";

/**
 * Purchase actions.
 *
 * As on the sales side, the form describes what was bought; the tax, the landed
 * cost and the accounting are worked out on the server.
 */

function revalidatePurchases(): void {
  for (const path of [
    "/app",
    "/app/purchases",
    "/app/products",
    "/app/suppliers",
  ]) {
    revalidatePath(path);
  }
}

async function guardOrigin(): Promise<ActionResult<never> | null> {
  const { origin, host } = await getRequestContext();
  if (!isSameOrigin(origin, host)) {
    return fail(
      "This request could not be verified. Please reload and try again.",
      { code: ACTION_ERROR.FORBIDDEN },
    );
  }
  return null;
}

function fromServiceError(error: unknown): ActionResult<never> {
  if (error instanceof PurchaseError) {
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
  console.error("Purchase action failed", error);
  return fail(
    "Something went wrong. Nothing was recorded — please try again.",
    {
      code: ACTION_ERROR.UNEXPECTED,
    },
  );
}

export async function createPurchaseAction(
  input: PurchaseInput,
): Promise<ActionResult<PostedPurchase>> {
  const originError = await guardOrigin();
  if (originError) return originError;

  const context = await assertPermission("purchases.create");

  const refusal = await billingRefusal(context.company.id, {
    limit: "transactionsPerMonth",
  });
  if (refusal) return refusal;
  const parsed = purchaseSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the bill below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const purchase = await createPurchase({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      branchId: context.membership.branchId,
      input: parsed.data,
    });
    revalidatePurchases();
    return ok(purchase);
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function voidPurchaseAction(
  purchaseId: string,
  input: VoidPurchaseInput,
): Promise<ActionResult<{ entryNumber: string }>> {
  const originError = await guardOrigin();
  if (originError) return originError;

  const context = await assertPermission("purchases.void");

  const refusal = await billingRefusal(context.company.id, {});
  if (refusal) return refusal;
  const parsed = voidPurchaseSchema.safeParse(input);
  if (!parsed.success) {
    return fail("A reason is required.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const result = await voidPurchase({
      companyId: context.company.id,
      purchaseId,
      userId: context.user.id,
      actorEmail: context.user.email,
      reason: parsed.data.reason,
    });
    revalidatePurchases();
    revalidatePath(`/app/purchases/${purchaseId}`);
    return ok(result);
  } catch (error) {
    return fromServiceError(error);
  }
}

export type PurchasableProduct = {
  id: string;
  sku: string;
  name: string;
  unitCode: string;
  /** What it last cost, as the starting rate on a bill line. */
  purchasePrice: string;
  taxPercent: string;
  hsnCode: string | null;
  isStockTracked: boolean;
  stockOnHand: string | null;
};

/**
 * Products a bill can name, matched on the server.
 *
 * A separate action from the sales-side search because the two need different
 * fields: a bill starts from what the product cost, an invoice from what it
 * sells for. Sharing one payload would ship the cost base to every cashier.
 */
export async function searchPurchasableProductsAction(
  query: string,
): Promise<PurchasableProduct[]> {
  const context = await assertPermission("purchases.create");
  const trimmed = query.trim();

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
      purchasePrice: true,
      isStockTracked: true,
      unit: { select: { code: true } },
      taxRate: { select: { ratePercent: true } },
      inventoryBalances: { select: { quantity: true } },
    },
    orderBy: { name: "asc" },
    take: 20,
  });

  return products.map((product) => ({
    id: product.id,
    sku: product.sku,
    name: product.name,
    unitCode: product.unit.code,
    purchasePrice: toStorageString(product.purchasePrice),
    taxPercent: toStorageString(product.taxRate?.ratePercent ?? 0),
    hsnCode: product.hsnCode,
    isStockTracked: product.isStockTracked,
    stockOnHand: product.isStockTracked
      ? toStorageString(
          product.inventoryBalances.reduce(
            (total, balance) => total.plus(balance.quantity),
            new Prisma.Decimal(0),
          ),
        )
      : null,
  }));
}
