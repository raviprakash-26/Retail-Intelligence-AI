import "server-only";
import { InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { recordAuditLog } from "@/server/audit/audit-log";
import {
  PaymentProviderError,
  RazorpayClient,
  razorpayCredentials,
  type Transport,
} from "./razorpay";

/**
 * Starting a payment.
 *
 * Two things are created before the browser is sent anywhere: an invoice of
 * ours in PENDING, and an order of the provider's for the same amount. The
 * invoice exists first so that a payment can never arrive for something we have
 * no record of asking for — the webhook finds its way home by the provider's
 * order id, which is stored on the invoice.
 *
 * Nothing is granted here. An upgrade applies when a payment is verified, and
 * that happens in the webhook handler, not on the way out.
 */

export class CheckoutError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}

/**
 * What the browser needs to open the provider's checkout.
 *
 * The key **id** is public — it identifies the merchant and appears in the page
 * source of every Razorpay integration in the world. The key *secret* never
 * leaves the server, and there is no field here that could carry it.
 */
export type CheckoutSession = {
  provider: "razorpay";
  keyId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  invoiceId: string;
  businessName: string;
  description: string;
  prefill: { name: string; email: string };
};

/** Human-readable invoice number, per month, per subscription. */
function invoiceNumber(subscriptionId: string, when: Date): string {
  const stamp = when.toISOString().slice(0, 10).replace(/-/g, "");
  return `SUB-${stamp}-${subscriptionId.slice(0, 8).toUpperCase()}-${when.getTime().toString(36).toUpperCase()}`;
}

/**
 * Opens a checkout for moving up to a paid plan.
 *
 * The amount is read from the plan on the server. Taking it from the request
 * would let somebody choose their own price, which is the single most obvious
 * way to break a payment integration and the one most often left open.
 */
export async function startPlanUpgrade(params: {
  companyId: string;
  planKey: string;
  userId: string;
  actorEmail: string;
  userName: string;
  transport?: Transport;
}): Promise<CheckoutSession> {
  const credentials = razorpayCredentials();
  if (!credentials) {
    throw new CheckoutError(
      "No payment provider is connected to this installation.",
      "NO_PROVIDER",
    );
  }

  const [subscription, target, company] = await Promise.all([
    prisma.subscription.findUnique({
      where: { companyId: params.companyId },
      select: {
        id: true,
        planId: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        plan: { select: { key: true, priceMinor: true } },
      },
    }),
    prisma.subscriptionPlan.findUnique({
      where: { key: params.planKey },
      select: {
        id: true,
        key: true,
        name: true,
        priceMinor: true,
        currency: true,
        isActive: true,
      },
    }),
    prisma.company.findUnique({
      where: { id: params.companyId },
      select: { name: true },
    }),
  ]);

  if (!subscription || !company) {
    throw new CheckoutError(
      "This business has no subscription.",
      "NO_SUBSCRIPTION",
    );
  }
  if (!target || !target.isActive) {
    throw new CheckoutError("That plan is not available.", "NO_PLAN");
  }
  if (target.id === subscription.planId) {
    throw new CheckoutError("That is already the current plan.", "SAME_PLAN");
  }
  if (target.priceMinor <= subscription.plan.priceMinor) {
    // Downgrades and sideways moves cost nothing, so they apply directly and
    // must not be routed through a payment that would collect nothing.
    throw new CheckoutError(
      "That plan does not cost more than the current one, so it does not need a payment.",
      "NO_PAYMENT_NEEDED",
    );
  }
  if (target.currency !== "INR") {
    throw new CheckoutError(
      "This installation can only take payments in rupees.",
      "UNSUPPORTED_CURRENCY",
    );
  }

  // An upgrade already waiting to be paid is reused rather than duplicated:
  // somebody who closes the checkout window and comes back should not
  // accumulate invoices, and two open orders for one upgrade is how a business
  // ends up paying twice.
  const existing = await prisma.subscriptionInvoice.findFirst({
    where: {
      subscriptionId: subscription.id,
      status: InvoiceStatus.PENDING,
      provider: "razorpay",
      providerInvoiceId: { not: null },
      targetPlanId: target.id,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, providerInvoiceId: true, amountMinor: true },
  });

  if (existing?.providerInvoiceId) {
    return {
      provider: "razorpay",
      keyId: credentials.keyId,
      orderId: existing.providerInvoiceId,
      amountMinor: existing.amountMinor,
      currency: "INR",
      invoiceId: existing.id,
      businessName: company.name,
      description: `${target.name} plan`,
      prefill: { name: params.userName, email: params.actorEmail },
    };
  }

  const now = new Date();
  const invoice = await prisma.subscriptionInvoice.create({
    data: {
      subscriptionId: subscription.id,
      number: invoiceNumber(subscription.id, now),
      status: InvoiceStatus.PENDING,
      amountMinor: target.priceMinor,
      currency: "INR",
      periodStart: subscription.currentPeriodStart,
      periodEnd: subscription.currentPeriodEnd,
      provider: "razorpay",
      targetPlanId: target.id,
    },
    select: { id: true, number: true },
  });

  const client = new RazorpayClient(credentials, params.transport);
  let order;
  try {
    order = await client.createOrder({
      amountMinor: target.priceMinor,
      currency: "INR",
      receipt: invoice.number,
      // Read back on the webhook only as a cross-check. The authoritative
      // link is the order id stored on the invoice below — notes are
      // caller-supplied data and are never trusted to decide who gets what.
      notes: {
        invoiceId: invoice.id,
        companyId: params.companyId,
        planKey: target.key,
      },
    });
  } catch (error) {
    // The invoice stays, marked failed with the reason. Deleting it would
    // erase the fact that somebody tried to pay and the gateway would not let
    // them, which is exactly what a support conversation needs.
    await prisma.subscriptionInvoice.update({
      where: { id: invoice.id },
      data: {
        status: InvoiceStatus.FAILED,
        failureReason:
          error instanceof PaymentProviderError
            ? error.message
            : "The payment provider could not be reached.",
      },
    });
    throw error;
  }

  // Belt and braces on the one number that matters. If the provider ever
  // echoed back a different amount, charging against it would mean collecting
  // something other than the price shown on the page.
  if (order.amountMinor !== target.priceMinor || order.currency !== "INR") {
    await prisma.subscriptionInvoice.update({
      where: { id: invoice.id },
      data: {
        status: InvoiceStatus.FAILED,
        failureReason: "The provider created an order for a different amount.",
      },
    });
    throw new CheckoutError(
      "The payment provider created an order for a different amount, so nothing was charged.",
      "AMOUNT_MISMATCH",
    );
  }

  await prisma.subscriptionInvoice.update({
    where: { id: invoice.id },
    data: { providerInvoiceId: order.id },
  });

  await recordAuditLog({
    action: "billing.checkout_started",
    module: "BILLING",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "SubscriptionInvoice",
    entityId: invoice.id,
    metadata: {
      planKey: target.key,
      amountMinor: target.priceMinor,
      orderId: order.id,
    },
  });

  return {
    provider: "razorpay",
    keyId: credentials.keyId,
    orderId: order.id,
    amountMinor: target.priceMinor,
    currency: "INR",
    invoiceId: invoice.id,
    businessName: company.name,
    description: `${target.name} plan`,
    prefill: { name: params.userName, email: params.actorEmail },
  };
}

/** Whether this installation is wired up to take money at all. */
export function checkoutAvailable(): boolean {
  return razorpayCredentials() !== null && Boolean(env.RAZORPAY_WEBHOOK_SECRET);
}
