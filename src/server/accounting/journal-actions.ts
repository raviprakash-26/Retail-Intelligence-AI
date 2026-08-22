"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  journalEntrySchema,
  voidJournalEntrySchema,
  type JournalEntryInput,
  type VoidJournalEntryInput,
} from "@/lib/validation/journal";
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
import {
  createManualEntry,
  reverseManualEntry,
  JournalError,
  type PostedManualEntry,
} from "./journal-service";

/**
 * Journal actions.
 *
 * Posting by hand needs `accounting.journal.create` and reversing needs
 * `accounting.journal.void`; the manager template carries neither, which is
 * deliberate. Someone who can post a free-form entry can move any figure in the
 * business to any other, so it belongs with the owner and the accountant.
 */

function revalidateJournal(): void {
  for (const path of ["/app", "/app/accounting", "/app/accounting/journal"]) {
    revalidatePath(path);
  }
}

function fromServiceError(error: unknown): ActionResult<never> {
  if (error instanceof JournalError) {
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
  console.error("Journal action failed", error);
  return fail("Something went wrong. Nothing was posted — please try again.", {
    code: ACTION_ERROR.UNEXPECTED,
  });
}

export async function createJournalEntryAction(
  input: JournalEntryInput,
): Promise<ActionResult<PostedManualEntry>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("accounting.journal.create");

  // A free-form entry reaches the ledger like any invoice does, so it passes
  // the same gate. Without this a lapsed subscription refused a sale and
  // allowed the debits and credits that sale would have posted.
  const refusal = await billingRefusal(context.company.id, {});
  if (refusal) return refusal;

  const parsed = journalEntrySchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the entry below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const entry = await createManualEntry({
      companyId: context.company.id,
      // A member tied to one branch posts to it, whatever the request says.
      branchId: context.membership.branchId,
      userId: context.user.id,
      actorEmail: context.user.email,
      input: parsed.data,
    });
    revalidateJournal();
    return ok(entry);
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function reverseJournalEntryAction(
  entryId: string,
  input: VoidJournalEntryInput,
): Promise<ActionResult<{ entryNumber: string }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("accounting.journal.void");

  // A reversal is a new entry, which is why every other void in the codebase
  // asks too.
  const refusal = await billingRefusal(context.company.id, {});
  if (refusal) return refusal;

  const parsed = voidJournalEntrySchema.safeParse(input);
  if (!parsed.success) {
    return fail("A reason is required.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const result = await reverseManualEntry({
      companyId: context.company.id,
      entryId,
      userId: context.user.id,
      actorEmail: context.user.email,
      reason: parsed.data.reason,
    });
    revalidateJournal();
    revalidatePath(`/app/accounting/journal/${entryId}`);
    return ok(result);
  } catch (error) {
    return fromServiceError(error);
  }
}

/**
 * Parties for a control-account line, fetched when one is needed.
 *
 * Most entries never touch a control account, so the whole customer and
 * supplier list is not something the journal form should be handed on every
 * page load.
 */
export async function journalPartiesAction(
  kind: "CUSTOMER" | "SUPPLIER",
): Promise<Array<{ id: string; name: string }>> {
  const context = await assertPermission("accounting.journal.create");

  const where = { companyId: context.company.id, archivedAt: null };
  const select = { id: true, name: true };
  const orderBy = { name: "asc" } as const;

  return kind === "CUSTOMER"
    ? prisma.customer.findMany({ where, select, orderBy, take: 500 })
    : prisma.supplier.findMany({ where, select, orderBy, take: 500 });
}
