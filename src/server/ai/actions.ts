"use server";

import { revalidatePath } from "next/cache";
import {
  ACTION_ERROR,
  fail,
  ok,
  type ActionResult,
} from "@/server/auth/action-result";
import { FEATURE } from "@/lib/billing/plans";
import { billingRefusal } from "@/server/billing/guards";
import { checkRateLimit } from "@/server/security/rate-limit";
import { assertPermission } from "@/server/auth/context";
import { resolveFiscalYear } from "@/server/fiscal/fiscal-service";
import { requireSameOrigin } from "@/server/security/request-context";
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
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("ai.accountant");

  const refusal = await billingRefusal(context.company.id, {
    feature: FEATURE.AI_ACCOUNTANT,
    limit: "aiMessagesPerMonth",
  });
  if (refusal) return refusal;

  // The plan's monthly allowance is the commercial limit. This is the safety
  // one: a loop calling this a thousand times a minute spends real money at the
  // provider long before a monthly count notices.
  const burst = await checkRateLimit("AI_MESSAGE_USER", context.user.id);
  if (!burst.allowed) {
    return fail("That is a lot of questions at once. Give it a moment.", {
      code: ACTION_ERROR.RATE_LIMITED,
      retryAfterSeconds: burst.retryAfterSeconds,
    });
  }

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
