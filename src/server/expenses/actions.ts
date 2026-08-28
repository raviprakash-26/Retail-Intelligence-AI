"use server";
import { logger } from "@/lib/observability/logger";

import { revalidatePath } from "next/cache";
import {
  expenseSchema,
  voidExpenseSchema,
  type ExpenseInput,
  type VoidExpenseInput,
} from "@/lib/validation/expenses";
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
  createExpense,
  voidExpense,
  ExpenseError,
  type PostedExpense,
} from "./expense-service";

/**
 * Expense actions.
 *
 * The two judgements that matter — capital or revenue, claimable or not — are
 * made on the server from the company's own registration and the category, not
 * taken on trust from the request.
 */

function revalidateExpenses(): void {
  for (const path of ["/app", "/app/expenses", "/app/suppliers"]) {
    revalidatePath(path);
  }
}

function fromServiceError(error: unknown): ActionResult<never> {
  if (error instanceof ExpenseError) {
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
  logger.error("Expense action failed", { module: "Expenses", error });
  return fail(
    "Something went wrong. Nothing was recorded — please try again.",
    {
      code: ACTION_ERROR.UNEXPECTED,
    },
  );
}

export async function createExpenseAction(
  input: ExpenseInput,
): Promise<ActionResult<PostedExpense>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("expenses.create");

  const refusal = await billingRefusal(context.company.id, {
    limit: "transactionsPerMonth",
  });
  if (refusal) return refusal;
  const parsed = expenseSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const expense = await createExpense({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      branchId: context.membership.branchId,
      input: parsed.data,
    });
    revalidateExpenses();
    return ok(expense);
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function voidExpenseAction(
  expenseId: string,
  input: VoidExpenseInput,
): Promise<ActionResult<{ entryNumber: string }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("expenses.void");

  const refusal = await billingRefusal(context.company.id, {});
  if (refusal) return refusal;
  const parsed = voidExpenseSchema.safeParse(input);
  if (!parsed.success) {
    return fail("A reason is required.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const result = await voidExpense({
      companyId: context.company.id,
      expenseId,
      userId: context.user.id,
      actorEmail: context.user.email,
      reason: parsed.data.reason,
    });
    revalidateExpenses();
    revalidatePath(`/app/expenses/${expenseId}`);
    return ok(result);
  } catch (error) {
    return fromServiceError(error);
  }
}
