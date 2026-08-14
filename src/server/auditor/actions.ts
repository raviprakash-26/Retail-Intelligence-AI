"use server";

import { revalidatePath } from "next/cache";
import { AuditFindingStatus } from "@prisma/client";
import {
  ACTION_ERROR,
  fail,
  ok,
  type ActionResult,
} from "@/server/auth/action-result";
import { FEATURE } from "@/lib/billing/plans";
import { billingRefusal } from "@/server/billing/guards";
import { assertPermission } from "@/server/auth/context";
import { resolveFiscalYear } from "@/server/fiscal/fiscal-service";
import { requireSameOrigin } from "@/server/security/request-context";
import { runAudit, settleFinding } from "@/server/auditor/audit-service";

/**
 * Running the checks, and recording what somebody decided about a finding.
 *
 * Both need `audit.run`, which the cashier template does not carry: a person
 * who can dismiss a finding about their own till should not be the only one
 * who ever sees it.
 */

const SETTLEMENTS: Record<string, AuditFindingStatus> = {
  ACKNOWLEDGED: AuditFindingStatus.ACKNOWLEDGED,
  RESOLVED: AuditFindingStatus.RESOLVED,
  DISMISSED: AuditFindingStatus.DISMISSED,
  FALSE_POSITIVE: AuditFindingStatus.FALSE_POSITIVE,
};

export async function runAuditAction(): Promise<
  ActionResult<{ score: number }>
> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("audit.run");

  const refusal = await billingRefusal(context.company.id, {
    feature: FEATURE.AI_AUDITOR,
  });
  if (refusal) return refusal;

  const year = await resolveFiscalYear(context.company.id);

  const to = new Date();
  const from = year?.startDate ?? new Date(to.getTime() - 365 * 86_400_000);

  const report = await runAudit({
    companyId: context.company.id,
    from,
    to,
    triggeredById: context.user.id,
  });

  revalidatePath("/app/ai/auditor");
  return ok({ score: report.run?.score ?? 0 });
}

export async function settleFindingAction(
  _previous: ActionResult<{ settled: true }> | null,
  formData: FormData,
): Promise<ActionResult<{ settled: true }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("audit.run");

  const findingId = String(formData.get("findingId") ?? "");
  const requested = String(formData.get("status") ?? "");
  const status = SETTLEMENTS[requested];

  if (!findingId || !status) {
    return fail("That is not something a finding can be marked as.", {
      code: ACTION_ERROR.INVALID_INPUT,
    });
  }

  const note = String(formData.get("note") ?? "").trim();

  // Scoped to this company inside the service: an id from elsewhere updates
  // nothing rather than somebody else's finding.
  const updated = await settleFinding({
    companyId: context.company.id,
    findingId,
    status,
    note: note || null,
    userId: context.user.id,
  });

  if (!updated) {
    return fail("That finding could not be found.", {
      code: ACTION_ERROR.INVALID_INPUT,
    });
  }

  revalidatePath("/app/ai/auditor");
  return ok({ settled: true });
}
