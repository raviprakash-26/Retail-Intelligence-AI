"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/server/auth/action-result";
import { assertPermission } from "@/server/auth/context";
import { requireSameOrigin } from "@/server/security/request-context";
import {
  closePeriod,
  reopenPeriod,
  PeriodError,
  type PeriodView,
} from "./period-service";
import {
  closeFiscalYear,
  reopenFiscalYear,
  YearCloseError,
  type YearCloseView,
} from "./year-close-service";

/**
 * Closing and reopening a period.
 *
 * Both gated on `accounting.period.close` — a permission that has been in the
 * catalogue and granted to the accountant role since the beginning, and until
 * now conferred nothing at all because nothing checked it.
 *
 * Reopening is the same permission rather than a stricter one. Somebody
 * trusted to decide the books are final is the same person who has to be able
 * to correct that decision; requiring a second grant would mean a shop that
 * closed a month in error had to wait for an owner to come back from holiday
 * before it could fix anything.
 */

const closeSchema = z.object({
  periodId: z.string().min(1),
  note: z.string().trim().max(300).optional().or(z.literal("")),
});

const reopenSchema = z.object({
  periodId: z.string().min(1),
  reason: z
    .string()
    .trim()
    .min(4, "Say why this period is being reopened.")
    .max(300, "Keep it to 300 characters."),
});

export async function closePeriodAction(
  input: unknown,
): Promise<ActionResult<PeriodView>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("accounting.period.close");

  const parsed = closeSchema.safeParse(input);
  if (!parsed.success) {
    return fail(
      parsed.error.issues[0]?.message ?? "That period could not be closed.",
    );
  }

  try {
    const period = await closePeriod({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      periodId: parsed.data.periodId,
      note: parsed.data.note || undefined,
    });
    revalidatePath("/app/accounting/periods");
    return ok(period);
  } catch (error) {
    if (error instanceof PeriodError) return fail(error.message);
    throw error;
  }
}

export async function reopenPeriodAction(
  input: unknown,
): Promise<ActionResult<PeriodView>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("accounting.period.close");

  const parsed = reopenSchema.safeParse(input);
  if (!parsed.success) {
    return fail(
      parsed.error.issues[0]?.message ?? "That period could not be reopened.",
    );
  }

  try {
    const period = await reopenPeriod({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      periodId: parsed.data.periodId,
      reason: parsed.data.reason,
    });
    revalidatePath("/app/accounting/periods");
    return ok(period);
  } catch (error) {
    if (error instanceof PeriodError) return fail(error.message);
    throw error;
  }
}

/**
 * Closing and reopening a year.
 *
 * The same permission as closing a month, for the same reason: it is the same
 * person's judgement about the same books. What differs is what the act does —
 * closing a month freezes it, closing a year settles what was earned and moves
 * it to retained earnings.
 */

const closeYearSchema = z.object({
  fiscalYearId: z.string().min(1),
  note: z.string().trim().max(300).optional().or(z.literal("")),
});

const reopenYearSchema = z.object({
  fiscalYearId: z.string().min(1),
  reason: z
    .string()
    .trim()
    .min(4, "Say why this year is being reopened.")
    .max(300, "Keep it to 300 characters."),
});

export async function closeFiscalYearAction(
  input: unknown,
): Promise<ActionResult<YearCloseView>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("accounting.period.close");

  const parsed = closeYearSchema.safeParse(input);
  if (!parsed.success) {
    return fail(
      parsed.error.issues[0]?.message ?? "That year could not be closed.",
    );
  }

  try {
    const year = await closeFiscalYear({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      fiscalYearId: parsed.data.fiscalYearId,
      note: parsed.data.note || undefined,
    });
    revalidatePath("/app/accounting/periods");
    return ok(year);
  } catch (error) {
    if (error instanceof YearCloseError) return fail(error.message);
    throw error;
  }
}

export async function reopenFiscalYearAction(
  input: unknown,
): Promise<ActionResult<YearCloseView>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("accounting.period.close");

  const parsed = reopenYearSchema.safeParse(input);
  if (!parsed.success) {
    return fail(
      parsed.error.issues[0]?.message ?? "That year could not be reopened.",
    );
  }

  try {
    const year = await reopenFiscalYear({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      fiscalYearId: parsed.data.fiscalYearId,
      reason: parsed.data.reason,
    });
    revalidatePath("/app/accounting/periods");
    return ok(year);
  } catch (error) {
    if (error instanceof YearCloseError) return fail(error.message);
    throw error;
  }
}
