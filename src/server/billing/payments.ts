import "server-only";
import { env } from "@/lib/env";
import { razorpayCredentials } from "./razorpay";

/**
 * Taking money.
 *
 * Razorpay is integrated. Whether *this* installation can charge anybody
 * depends on whether it has been given credentials, and most will not have
 * been — so the honest states are enumerated here rather than assumed, and the
 * billing page says which one it is in.
 *
 * The webhook secret is required, not optional. Without it there is no way to
 * verify that a payment notification came from the provider, and a checkout
 * that can be opened but never confirmed would take somebody's money and leave
 * their plan unchanged. Refusing to offer the button is the correct behaviour;
 * offering one that cannot complete is not.
 *
 * What works without any provider is everything that costs nothing: starting a
 * trial, moving to a cheaper plan, cancelling, and reading every figure.
 */

export type PaymentsStatus =
  | { available: true; provider: "razorpay" }
  | { available: false; reason: string };

export function paymentsStatus(): PaymentsStatus {
  if (env.PAYMENTS_DRIVER === "disabled") {
    return {
      available: false,
      reason:
        "No payment provider is connected to this installation, so nothing here can take a payment.",
    };
  }

  if (env.PAYMENTS_DRIVER === "stripe") {
    // The seam is provider-shaped, but only one provider has been written.
    // Saying so beats a button that resolves against nothing.
    return {
      available: false,
      reason:
        "This installation is configured for Stripe, which this build does not talk to. Razorpay is the provider that has been integrated.",
    };
  }

  if (!razorpayCredentials()) {
    return {
      available: false,
      reason:
        "Razorpay is selected but its keys are missing, so no payment can be taken.",
    };
  }

  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    return {
      available: false,
      reason:
        "Razorpay is connected but RAZORPAY_WEBHOOK_SECRET is not set. Without it a payment cannot be confirmed, so no payment will be started.",
    };
  }

  return { available: true, provider: "razorpay" };
}

/** Whether a plan change needs money to change hands before it can apply. */
export function requiresPayment(params: {
  currentPriceMinor: number;
  targetPriceMinor: number;
}): boolean {
  return params.targetPriceMinor > params.currentPriceMinor;
}
