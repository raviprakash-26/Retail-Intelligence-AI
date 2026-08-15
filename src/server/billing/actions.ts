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
import {
  CheckoutError,
  startPlanUpgrade,
  type CheckoutSession,
} from "@/server/billing/checkout";
import { PaymentProviderError } from "@/server/billing/razorpay";

/**
 * Changing the plan, and stopping it.
 *
 * All three need `billing.manage`, which only the owner and administrator
 * templates carry — a cashier should not be able to cancel the subscription
 * their shop runs on.
 *
 * An upgrade goes through `startPlanUpgradeAction`, which opens a checkout and
 * grants nothing. The plan moves when the provider confirms the payment, in the
 * webhook handler — never here, and never because a browser said so.
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
    return fail(result.reason, {
      // A refusal that a payment would resolve is a different thing from one
      // nothing can, and the page offers a "Pay" button for exactly one of them.
      code: result.needsCheckout ? "NEEDS_PAYMENT" : ACTION_ERROR.FORBIDDEN,
    });
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

/**
 * Opens a checkout for an upgrade.
 *
 * Returns only what the browser needs to hand to the provider's widget: the
 * public key id, the order id, and the amount to display. The key secret and
 * the webhook secret never leave the server, and neither appears in this type.
 *
 * Note what is *not* here: no action that marks anything paid. The browser
 * cannot grant itself a plan by calling something, because there is nothing to
 * call — the only path to a paid invoice is a signed webhook.
 */
export async function startPlanUpgradeAction(
  planKey: string,
): Promise<ActionResult<CheckoutSession>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("billing.manage");

  try {
    const session = await startPlanUpgrade({
      companyId: context.company.id,
      planKey,
      userId: context.user.id,
      actorEmail: context.user.email,
      userName: context.user.fullName,
    });
    revalidatePath("/app/settings/billing");
    return ok(session);
  } catch (error) {
    if (error instanceof CheckoutError) {
      return fail(error.message, { code: error.code });
    }
    if (error instanceof PaymentProviderError) {
      // The gateway refused or could not be reached. Nothing was charged, and
      // saying so plainly matters more than the provider's own wording.
      return fail(`${error.message} Nothing has been charged.`, {
        code: error.code,
      });
    }
    console.error("Starting a plan upgrade failed", error);
    return fail(
      "Something went wrong starting the payment. Nothing has been charged.",
      { code: ACTION_ERROR.UNEXPECTED },
    );
  }
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
