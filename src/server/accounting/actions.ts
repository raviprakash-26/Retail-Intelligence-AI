"use server";

import { revalidatePath } from "next/cache";
import {
  accountEditSchema,
  accountSchema,
  type AccountEditInput,
  type AccountInput,
} from "@/lib/validation/accounts";
import {
  ACTION_ERROR,
  fail,
  ok,
  zodFieldErrors,
  type ActionResult,
} from "@/server/auth/action-result";
import { assertPermission } from "@/server/auth/context";
import { requireSameOrigin } from "@/server/security/request-context";
import {
  createAccount,
  isDuplicateAccountCode,
  setAccountActive,
  updateAccount,
  AccountError,
} from "./account-service";

/**
 * Chart of accounts actions.
 *
 * Every one of them requires `accounting.accounts.manage`, which the cashier
 * and auditor role templates do not carry. An auditor who could reshape the
 * chart is not auditing it.
 */

function revalidateAccounting(): void {
  revalidatePath("/app/accounting");
  revalidatePath("/app/reports");
}

function fromServiceError(error: unknown): ActionResult<never> {
  if (error instanceof AccountError) {
    return fail(error.message, {
      code: error.code,
      fieldErrors: error.field ? { [error.field]: error.message } : undefined,
    });
  }
  if (isDuplicateAccountCode(error)) {
    return fail("That code is already in use.", {
      code: "DUPLICATE_CODE",
      fieldErrors: { code: "That code is already in use." },
    });
  }
  console.error("Account action failed", error);
  return fail("Something went wrong. Nothing was changed — please try again.", {
    code: ACTION_ERROR.UNEXPECTED,
  });
}

export async function createAccountAction(
  input: AccountInput,
): Promise<ActionResult<{ id: string; code: string; name: string }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("accounting.accounts.manage");
  const parsed = accountSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const account = await createAccount({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      input: parsed.data,
    });
    revalidateAccounting();
    return ok(account);
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function updateAccountAction(
  accountId: string,
  input: AccountEditInput,
): Promise<ActionResult<{ id: string; name: string }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("accounting.accounts.manage");
  const parsed = accountEditSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const account = await updateAccount({
      companyId: context.company.id,
      accountId,
      userId: context.user.id,
      actorEmail: context.user.email,
      input: parsed.data,
    });
    revalidateAccounting();
    return ok(account);
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function setAccountActiveAction(
  accountId: string,
  isActive: boolean,
): Promise<ActionResult<{ id: string; name: string; isActive: boolean }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("accounting.accounts.manage");

  try {
    const account = await setAccountActive({
      companyId: context.company.id,
      accountId,
      userId: context.user.id,
      actorEmail: context.user.email,
      isActive,
    });
    revalidateAccounting();
    return ok(account);
  } catch (error) {
    return fromServiceError(error);
  }
}
