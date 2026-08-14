"use server";

import { revalidatePath } from "next/cache";
import {
  purchaseReturnSchema,
  salesReturnSchema,
  type PurchaseReturnInput,
  type SalesReturnInput,
} from "@/lib/validation/returns";
import {
  ACTION_ERROR,
  fail,
  ok,
  zodFieldErrors,
  type ActionResult,
} from "@/server/auth/action-result";
import { assertPermission } from "@/server/auth/context";
import { billingRefusal } from "@/server/billing/guards";
import {
  NoFiscalPeriodError,
  PeriodClosedError,
} from "@/server/accounting/post-journal-entry";
import { requireSameOrigin } from "@/server/security/request-context";
import { ReturnError } from "@/server/returns/errors";
import {
  createSalesReturn,
  type PostedSalesReturn,
} from "@/server/returns/sales-return-service";
import {
  createPurchaseReturn,
  type PostedPurchaseReturn,
} from "@/server/returns/purchase-return-service";

/**
 * Return actions.
 *
 * The form sends a document id, a date and a quantity per line. It does not
 * send a price, a tax rate or a total, because a return has to reverse what the
 * original document said rather than what the browser now claims — the service
 * reads all three from the invoice or bill being returned against.
 *
 * A return is a posting, so it goes through the same two gates as any other:
 * the member's permission, and whether the subscription may post at all.
 */

function revalidateReturns(kind: "sales" | "purchases", documentId: string) {
  for (const path of [
    "/app",
    "/app/returns",
    `/app/${kind}`,
    `/app/${kind}/${documentId}`,
    "/app/products",
    "/app/gst",
  ]) {
    revalidatePath(path);
  }
}

function fromServiceError(error: unknown): ActionResult<never> {
  if (error instanceof ReturnError) {
    return fail(error.message, { code: error.code });
  }
  if (
    error instanceof PeriodClosedError ||
    error instanceof NoFiscalPeriodError
  ) {
    return fail(error.message, { code: "PERIOD_UNAVAILABLE" });
  }
  console.error("Return action failed", error);
  return fail(
    "Something went wrong. Nothing was recorded — please try again.",
    { code: ACTION_ERROR.UNEXPECTED },
  );
}

export async function createSalesReturnAction(
  input: SalesReturnInput,
): Promise<ActionResult<PostedSalesReturn>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("sales.return");

  const refusal = await billingRefusal(context.company.id, {
    limit: "transactionsPerMonth",
  });
  if (refusal) return refusal;

  const parsed = salesReturnSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the return below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const result = await createSalesReturn({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      branchId: context.membership.branchId,
      input: parsed.data,
    });
    revalidateReturns("sales", parsed.data.saleId);
    return ok(result);
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function createPurchaseReturnAction(
  input: PurchaseReturnInput,
): Promise<ActionResult<PostedPurchaseReturn>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("purchases.return");

  const refusal = await billingRefusal(context.company.id, {
    limit: "transactionsPerMonth",
  });
  if (refusal) return refusal;

  const parsed = purchaseReturnSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the return below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const result = await createPurchaseReturn({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      branchId: context.membership.branchId,
      input: parsed.data,
    });
    revalidateReturns("purchases", parsed.data.purchaseId);
    return ok(result);
  } catch (error) {
    return fromServiceError(error);
  }
}
