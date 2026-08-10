"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  paymentSchema,
  receiptSchema,
  voidSettlementSchema,
  type PaymentInput,
  type ReceiptInput,
  type VoidSettlementInput,
} from "@/lib/validation/settlements";
import {
  ACTION_ERROR,
  fail,
  ok,
  zodFieldErrors,
  type ActionResult,
} from "@/server/auth/action-result";
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
import { openBills, openInvoices, type OpenDocument } from "./outstanding";
import {
  createPayment,
  createReceipt,
  voidPayment,
  voidReceipt,
  SettlementError,
  type PostedSettlement,
} from "./settlement-service";

/**
 * Receipt and payment actions.
 *
 * Allocation figures arrive from the client, but every one of them is checked
 * against the document's own outstanding amount inside the posting transaction.
 * A request claiming to settle ₹50,000 against a ₹5,000 invoice is refused with
 * both figures named.
 */

function revalidateSettlements(): void {
  for (const path of [
    "/app",
    "/app/receipts",
    "/app/payments",
    "/app/sales",
    "/app/purchases",
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
  if (error instanceof SettlementError) {
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
  console.error("Settlement action failed", error);
  return fail(
    "Something went wrong. Nothing was recorded — please try again.",
    {
      code: ACTION_ERROR.UNEXPECTED,
    },
  );
}

export async function createReceiptAction(
  input: ReceiptInput,
): Promise<ActionResult<PostedSettlement>> {
  const originError = await guardOrigin();
  if (originError) return originError;

  const context = await assertPermission("receipts.create");
  const parsed = receiptSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const receipt = await createReceipt({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      input: parsed.data,
    });
    revalidateSettlements();
    return ok(receipt);
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function createPaymentAction(
  input: PaymentInput,
): Promise<ActionResult<PostedSettlement>> {
  const originError = await guardOrigin();
  if (originError) return originError;

  const context = await assertPermission("payments.create");
  const parsed = paymentSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const payment = await createPayment({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      input: parsed.data,
    });
    revalidateSettlements();
    return ok(payment);
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function voidReceiptAction(
  receiptId: string,
  input: VoidSettlementInput,
): Promise<ActionResult<{ entryNumber: string }>> {
  const originError = await guardOrigin();
  if (originError) return originError;

  const context = await assertPermission("receipts.void");
  const parsed = voidSettlementSchema.safeParse(input);
  if (!parsed.success) {
    return fail("A reason is required.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const result = await voidReceipt({
      companyId: context.company.id,
      receiptId,
      userId: context.user.id,
      actorEmail: context.user.email,
      reason: parsed.data.reason,
    });
    revalidateSettlements();
    revalidatePath(`/app/receipts/${receiptId}`);
    return ok(result);
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function voidPaymentAction(
  paymentId: string,
  input: VoidSettlementInput,
): Promise<ActionResult<{ entryNumber: string }>> {
  const originError = await guardOrigin();
  if (originError) return originError;

  const context = await assertPermission("payments.void");
  const parsed = voidSettlementSchema.safeParse(input);
  if (!parsed.success) {
    return fail("A reason is required.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const result = await voidPayment({
      companyId: context.company.id,
      paymentId,
      userId: context.user.id,
      actorEmail: context.user.email,
      reason: parsed.data.reason,
    });
    revalidateSettlements();
    revalidatePath(`/app/payments/${paymentId}`);
    return ok(result);
  } catch (error) {
    return fromServiceError(error);
  }
}

/**
 * What a party still owes, for the allocation table.
 *
 * Fetched when a party is chosen rather than shipped with the page: the whole
 * outstanding ledger of every customer is not something a form needs, and it is
 * exactly what someone would want if they got hold of a session they should
 * not have.
 */
export async function openInvoicesAction(
  customerId: string,
): Promise<OpenDocument[]> {
  const context = await assertPermission("receipts.create");
  return openInvoices(prisma, { companyId: context.company.id, customerId });
}

export async function openBillsAction(
  supplierId: string,
): Promise<OpenDocument[]> {
  const context = await assertPermission("payments.create");
  return openBills(prisma, { companyId: context.company.id, supplierId });
}
