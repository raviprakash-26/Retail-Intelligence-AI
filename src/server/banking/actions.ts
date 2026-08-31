"use server";
import { logger } from "@/lib/observability/logger";

import { revalidatePath } from "next/cache";
import {
  bankAccountSchema,
  matchSchema,
  recordFromStatementSchema,
  statementImportSchema,
  unmatchSchema,
  type BankAccountInput,
  type RecordFromStatementInput,
  type StatementImportInput,
} from "@/lib/validation/banking";
import { StatementFormatError } from "@/lib/banking/statement-parser";
import {
  ACTION_ERROR,
  fail,
  ok,
  zodFieldErrors,
  type ActionResult,
} from "@/server/auth/action-result";
import { assertPermission } from "@/server/auth/context";
import { billingRefusal } from "@/server/billing/guards";
import { requireSameOrigin } from "@/server/security/request-context";
import {
  NoFiscalPeriodError,
  PeriodClosedError,
} from "@/server/accounting/post-journal-entry";
import { MissingAccountError } from "@/server/documents/accounts";
import { BankAccountError, createBankAccount } from "./bank-account-service";
import { importStatement, type ImportSummary } from "./statement-import";
import { matchTransaction, unmatchTransaction } from "./reconciliation-service";
import { recordFromStatement } from "./record-from-statement";

/**
 * Banking actions.
 *
 * Importing and matching are gated on `banking.reconcile` rather than on
 * `banking.view`: reading a reconciliation and asserting that two figures are
 * the same transaction are different acts, and the second one changes what the
 * business believes about its own bank balance.
 */

function revalidateBanking(bankAccountId?: string): void {
  revalidatePath("/app/accounting/banking");
  if (bankAccountId) {
    revalidatePath(`/app/accounting/banking/${bankAccountId}`);
  }
  revalidatePath("/app/accounting/ledger");
}

function fromServiceError(error: unknown): ActionResult<never> {
  if (error instanceof BankAccountError) {
    return fail(error.message, {
      code: error.code,
      fieldErrors: error.field ? { [error.field]: error.message } : undefined,
    });
  }
  if (error instanceof StatementFormatError) {
    return fail(error.message, { code: "UNREADABLE_FILE" });
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
  logger.error("Banking action failed", { module: "Banking", error });
  return fail("Something went wrong. Nothing was changed — please try again.", {
    code: ACTION_ERROR.UNEXPECTED,
  });
}

export async function createBankAccountAction(
  input: BankAccountInput,
): Promise<ActionResult<{ id: string; name: string }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("banking.reconcile");
  const refusal = await billingRefusal(context.company.id, {});
  if (refusal) return refusal;

  const parsed = bankAccountSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const created = await createBankAccount({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      input: parsed.data,
    });
    revalidateBanking();
    return ok(created);
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function importStatementAction(
  input: StatementImportInput,
): Promise<ActionResult<ImportSummary>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("banking.reconcile");
  const refusal = await billingRefusal(context.company.id, {});
  if (refusal) return refusal;

  const parsed = statementImportSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the file and try again.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const summary = await importStatement({
      companyId: context.company.id,
      bankAccountId: parsed.data.bankAccountId,
      content: parsed.data.content,
      fileName: parsed.data.fileName,
      userId: context.user.id,
      actorEmail: context.user.email,
    });
    revalidateBanking(parsed.data.bankAccountId);
    return ok(summary);
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function matchTransactionAction(
  input: unknown,
): Promise<ActionResult<{ entryNumber: string }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("banking.reconcile");
  const parsed = matchSchema.safeParse(input);
  if (!parsed.success) {
    return fail("That is not something this page can match.", {
      code: ACTION_ERROR.INVALID_INPUT,
    });
  }

  try {
    const result = await matchTransaction({
      companyId: context.company.id,
      bankTransactionId: parsed.data.bankTransactionId,
      journalEntryId: parsed.data.journalEntryId,
      userId: context.user.id,
      actorEmail: context.user.email,
    });
    revalidateBanking();
    return ok({ entryNumber: result.entryNumber });
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function unmatchTransactionAction(
  input: unknown,
): Promise<ActionResult<{ bankTransactionId: string }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("banking.reconcile");
  const parsed = unmatchSchema.safeParse(input);
  if (!parsed.success) {
    return fail("That is not something this page can unmatch.", {
      code: ACTION_ERROR.INVALID_INPUT,
    });
  }

  try {
    const result = await unmatchTransaction({
      companyId: context.company.id,
      bankTransactionId: parsed.data.bankTransactionId,
      userId: context.user.id,
      actorEmail: context.user.email,
      // Unmatching a line the banking module posted from reverses that entry,
      // and reversing is posting. Asked separately rather than folded into the
      // permission above, so a reconciler who cannot post can still break a
      // match somebody made by hand — which posts nothing.
      mayPost: context.permissions.has("accounting.journal.create"),
    });
    revalidateBanking();
    return ok(result);
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function recordFromStatementAction(
  input: RecordFromStatementInput,
): Promise<ActionResult<{ entryNumber: string }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  // Posting an entry is a heavier act than matching two that already exist, so
  // it asks for the permission that allows posting as well.
  const context = await assertPermission("accounting.journal.create");
  const refusal = await billingRefusal(context.company.id, {});
  if (refusal) return refusal;

  const parsed = recordFromStatementSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const result = await recordFromStatement({
      companyId: context.company.id,
      bankTransactionId: parsed.data.bankTransactionId,
      kind: parsed.data.kind,
      narration: parsed.data.narration,
      userId: context.user.id,
      actorEmail: context.user.email,
    });
    revalidateBanking();
    revalidatePath("/app/accounting/journal");
    return ok({ entryNumber: result.entryNumber });
  } catch (error) {
    return fromServiceError(error);
  }
}
