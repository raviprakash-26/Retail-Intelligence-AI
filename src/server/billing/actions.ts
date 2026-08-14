"use server";

import { revalidatePath } from "next/cache";
import {
  ACTION_ERROR,
  fail,
  ok,
  type ActionResult,
} from "@/server/auth/action-result";
import { assertPermission } from "@/server/auth/context";
import { requireSameOrigin } from "@/server/security/request-context";
import {
  cancelSubscription,
  changePlan,
  resumeSubscription,
} from "@/server/billing/subscription-service";

/**
 * Changing the plan, and stopping it.
 *
 * All three need `billing.manage`, which only the owner and administrator
 * templates carry — a cashier should not be able to cancel the subscription
 * their shop runs on.
 *
 * Nothing here takes a payment, because nothing in this build can. An action
 * that would need money to change hands returns the reason instead.
 */

export async function changePlanAction(
  planKey: string,
): Promise<ActionResult<{ planName: string; overLimit: string[] }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("billing.manage");

  const result = await changePlan({
    companyId: context.company.id,
    planKey,
    userId: context.user.id,
    actorEmail: context.user.email,
  });

  if (!result.changed) {
    return fail(result.reason, { code: ACTION_ERROR.FORBIDDEN });
  }

  revalidatePath("/app/settings/billing");
  revalidatePath("/app", "layout");
  return ok({
    planName: result.planName,
    // What the new allowances no longer cover, said now rather than found out
    // later by somebody who cannot add a user.
    overLimit: result.overLimit.map((line) => line.label),
  });
}

export async function cancelSubscriptionAction(): Promise<
  ActionResult<{ cancelled: true }>
> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("billing.manage");
  const cancelled = await cancelSubscription({
    companyId: context.company.id,
    userId: context.user.id,
    actorEmail: context.user.email,
  });

  if (!cancelled) {
    return fail("There is no subscription to cancel.", {
      code: ACTION_ERROR.INVALID_INPUT,
    });
  }

  revalidatePath("/app/settings/billing");
  return ok({ cancelled: true });
}

export async function resumeSubscriptionAction(): Promise<
  ActionResult<{ resumed: true }>
> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("billing.manage");
  const resumed = await resumeSubscription({
    companyId: context.company.id,
    userId: context.user.id,
    actorEmail: context.user.email,
  });

  if (!resumed) {
    return fail("There is no cancellation to withdraw.", {
      code: ACTION_ERROR.INVALID_INPUT,
    });
  }

  revalidatePath("/app/settings/billing");
  return ok({ resumed: true });
}
