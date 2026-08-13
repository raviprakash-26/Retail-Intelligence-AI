"use server";

import { revalidatePath } from "next/cache";
import {
  ACTION_ERROR,
  fail,
  ok,
  type ActionResult,
} from "@/server/auth/action-result";
import { assertPermission } from "@/server/auth/context";
import { resolveFiscalYear } from "@/server/fiscal/fiscal-service";
import {
  getRequestContext,
  isSameOrigin,
} from "@/server/security/request-context";
import { askAccountant } from "@/server/ai/accountant";

/**
 * Asking the accountant.
 *
 * The tenant, the user and the financial year are all resolved here from the
 * session — never from the form, and never from anything the model said. What
 * crosses the boundary from the browser is one string of text.
 */

const MAX_QUESTION = 1_000;

export async function askAccountantAction(
  _previous: ActionResult<{ conversationId: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ conversationId: string }>> {
  const { origin, host } = await getRequestContext();
  if (!isSameOrigin(origin, host)) {
    return fail("That request did not look right.", {
      code: ACTION_ERROR.FORBIDDEN,
    });
  }

  const context = await assertPermission("ai.accountant");

  const question = String(formData.get("question") ?? "").trim();
  if (!question) {
    return fail("Ask a question first.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: { question: "Ask a question first." },
    });
  }
  if (question.length > MAX_QUESTION) {
    return fail(`Keep the question under ${MAX_QUESTION} characters.`, {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: {
        question: `Keep the question under ${MAX_QUESTION} characters.`,
      },
    });
  }

  // A conversation id from the form is a suggestion: the service only honours
  // one belonging to this company *and* this user.
  const raw = formData.get("conversationId");
  const conversationId = typeof raw === "string" && raw ? raw : null;

  const fiscalYear = await resolveFiscalYear(context.company.id);
  const isoDay = (date: Date) => date.toISOString().slice(0, 10);

  const result = await askAccountant({
    companyId: context.company.id,
    userId: context.user.id,
    question,
    conversationId,
    context: {
      companyId: context.company.id,
      fiscalYearStart: fiscalYear?.startDate ?? null,
      fiscalYearEnd: fiscalYear?.endDate ?? null,
    },
    business: {
      name: context.company.name,
      currency: context.company.currency,
      fiscalYearLabel: fiscalYear?.label ?? null,
      fiscalYearFrom: fiscalYear ? isoDay(fiscalYear.startDate) : null,
      fiscalYearTo: fiscalYear ? isoDay(fiscalYear.endDate) : null,
    },
  });

  revalidatePath("/app/ai/accountant");

  if (!result.ok) {
    return fail(result.error, { code: ACTION_ERROR.UNEXPECTED });
  }
  return ok({ conversationId: result.conversationId });
}
