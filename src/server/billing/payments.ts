import "server-only";
import { env } from "@/lib/env";

/**
 * Taking money.
 *
 * **This build cannot charge anybody.** The environment schema knows about
 * Razorpay and Stripe, the subscription tables carry the provider columns, and
 * this module is the seam an integration goes into — but no integration has
 * been written, and nothing here pretends otherwise.
 *
 * That refusal is the point. A billing page with a working-looking "Pay now"
 * button that resolves against nothing would be a lie told to a shopkeeper
 * about their own money, and a fake success would leave a subscription marked
 * paid that no bank has ever heard of. So the page says plainly that no
 * payments can be taken here, in the same way the GST page says it cannot file
 * and the assistant says when it has no provider.
 *
 * What still works without a provider is everything that costs nothing:
 * starting a trial, moving to a cheaper plan, cancelling, and reading every
 * figure on the page.
 */

export type PaymentsStatus =
  | { available: true; provider: "razorpay" | "stripe" }
  | { available: false; reason: string };

export function paymentsStatus(): PaymentsStatus {
  if (env.PAYMENTS_DRIVER === "disabled") {
    return {
      available: false,
      reason:
        "No payment provider is connected to this installation, so nothing here can take a payment.",
    };
  }

  // Configured, but this build has no code that talks to them. Saying so is
  // better than a button that appears to work.
  return {
    available: false,
    reason: `This installation is configured for ${env.PAYMENTS_DRIVER}, which this build does not talk to yet. No payment can be taken.`,
  };
}

/** Whether a plan change needs money to change hands before it can apply. */
export function requiresPayment(params: {
  currentPriceMinor: number;
  targetPriceMinor: number;
}): boolean {
  return params.targetPriceMinor > params.currentPriceMinor;
}
