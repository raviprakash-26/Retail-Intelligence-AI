import "server-only";
import { InvoiceStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { recordAuditLog } from "@/server/audit/audit-log";
import { logger } from "@/lib/observability/logger";
import { readPayment, type ProviderPayment } from "./razorpay";
import { verifyWebhookSignature } from "./signature";

/**
 * Acting on what the payment provider says happened.
 *
 * This is the only place in the product where a subscription becomes paid. Not
 * the browser coming back from checkout — that says only that somebody's
 * browser reached a URL, and it can lie by simply never arriving. A payment is
 * real when the provider tells our server it is, over a channel signed with a
 * secret only the two of us hold.
 *
 * Four rules, each guarding a different way this goes wrong:
 *
 *   1. **Verify before reading.** An unsigned body is recorded and dropped. It
 *      is never parsed for meaning.
 *   2. **Record before acting.** The event row is written first, so a crash
 *      halfway through leaves evidence rather than silence.
 *   3. **Apply once.** Providers retry deliveries on purpose. The unique key on
 *      (provider, eventId) turns the second delivery into a no-op.
 *   4. **Check the amount against our own invoice.** Otherwise somebody opens a
 *      checkout for ₹1, pays it, and the webhook cheerfully upgrades them.
 */

export type WebhookOutcome =
  | { handled: true; outcome: string; invoiceId?: string }
  | { handled: false; status: number; outcome: string };

/** Events worth acting on. Everything else is recorded and acknowledged. */
const HANDLED_EVENTS = new Set([
  "payment.captured",
  "payment.failed",
  "order.paid",
]);

export async function handleRazorpayWebhook(params: {
  rawBody: string;
  signature: string | null;
  eventId: string | null;
}): Promise<WebhookOutcome> {
  const secret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    // Nothing is configured to receive this. Answering 404 rather than 500
    // keeps an unconfigured installation from advertising an endpoint it
    // cannot use.
    return { handled: false, status: 404, outcome: "NOT_CONFIGURED" };
  }

  const verified = verifyWebhookSignature({
    rawBody: params.rawBody,
    signature: params.signature,
    secret,
  });

  // The event id comes from a header on an unverified request, so it is not
  // trustworthy on its own — but it is only ever used as a deduplication key,
  // and a forged one can at worst suppress an event that failed verification
  // anyway. Where the header is missing, the body's own hash stands in, which
  // deduplicates identical redeliveries just as well.
  const eventId = params.eventId ?? fingerprint(params.rawBody);

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(params.rawBody);
  } catch {
    parsed = null;
  }
  const eventType =
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as { event?: unknown }).event === "string"
      ? (parsed as { event: string }).event
      : "unknown";

  if (!verified) {
    // Recorded, deliberately. A run of these is somebody probing the endpoint,
    // and that is worth being able to see. The body is stored as text rather
    // than parsed JSON: it did not come from the provider, so it is not
    // treated as structured data.
    await recordEvent({
      eventId,
      eventType,
      verified: false,
      payload: { unverified: params.rawBody.slice(0, 4_000) },
      outcome: "BAD_SIGNATURE",
      processed: true,
    });
    logger.warn("Rejected a payment webhook with a bad signature", {
      module: "Billing",
      eventType,
    });
    return { handled: false, status: 400, outcome: "BAD_SIGNATURE" };
  }

  // Verified, so the body is now safe to treat as the provider's own words.
  const created = await recordEvent({
    eventId,
    eventType,
    verified: true,
    payload: (parsed ?? {}) as Prisma.InputJsonValue,
    outcome: null,
    processed: false,
  });

  if (!created) {
    // Already seen. This is the normal path for a retry, not an error.
    return { handled: true, outcome: "DUPLICATE" };
  }

  if (!HANDLED_EVENTS.has(eventType)) {
    await finish(eventId, "IGNORED_EVENT_TYPE");
    return { handled: true, outcome: "IGNORED_EVENT_TYPE" };
  }

  const payment = extractPayment(parsed);
  if (!payment) {
    await finish(eventId, "NO_PAYMENT_IN_PAYLOAD");
    return { handled: true, outcome: "NO_PAYMENT_IN_PAYLOAD" };
  }

  const result =
    eventType === "payment.failed"
      ? await applyFailure(payment)
      : await applyCapture(payment);

  await finish(eventId, result.outcome, result.invoiceId, result.companyId);
  return {
    handled: true,
    outcome: result.outcome,
    invoiceId: result.invoiceId,
  };
}

/** A stable id for a body, when the provider did not send one. */
function fingerprint(rawBody: string): string {
  // Not a security control — only a deduplication key — so a short digest of
  // the exact bytes is enough.
  let hash = 0;
  for (let index = 0; index < rawBody.length; index += 1) {
    hash = (Math.imul(31, hash) + rawBody.charCodeAt(index)) | 0;
  }
  return `body:${(hash >>> 0).toString(36)}:${rawBody.length}`;
}

function extractPayment(parsed: unknown): ProviderPayment | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const payload = (parsed as { payload?: unknown }).payload;
  if (typeof payload !== "object" || payload === null) return null;
  const entity = (payload as { payment?: { entity?: unknown } }).payment
    ?.entity;
  if (typeof entity !== "object" || entity === null) return null;
  try {
    return readPayment(entity as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Writes the event, or reports that it was already there.
 *
 * The unique violation is the whole point rather than an error to be logged:
 * it is how a redelivered webhook is recognised, and catching it is cheaper and
 * more reliable than reading first and hoping nothing else writes in between.
 */
async function recordEvent(params: {
  eventId: string;
  eventType: string;
  verified: boolean;
  payload: Prisma.InputJsonValue;
  outcome: string | null;
  processed: boolean;
}): Promise<boolean> {
  try {
    await prisma.paymentEvent.create({
      data: {
        provider: "razorpay",
        eventId: params.eventId,
        eventType: params.eventType,
        signatureVerified: params.verified,
        payload: params.payload,
        outcome: params.outcome,
        processedAt: params.processed ? new Date() : null,
      },
    });
    return true;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return false;
    }
    throw error;
  }
}

async function finish(
  eventId: string,
  outcome: string,
  invoiceId?: string,
  companyId?: string,
): Promise<void> {
  await prisma.paymentEvent.updateMany({
    where: { provider: "razorpay", eventId },
    data: {
      processedAt: new Date(),
      outcome,
      invoiceId: invoiceId ?? null,
      companyId: companyId ?? null,
    },
  });
}

type ApplyResult = {
  outcome: string;
  invoiceId?: string;
  companyId?: string;
};

/**
 * A captured payment: mark the invoice paid and move the plan.
 *
 * Everything happens in one transaction, and the plan moves only if the invoice
 * was still pending — so two deliveries racing past the idempotency key would
 * still upgrade once.
 */
async function applyCapture(payment: ProviderPayment): Promise<ApplyResult> {
  if (!payment.orderId) return { outcome: "NO_ORDER_ON_PAYMENT" };

  return prisma.$transaction(async (tx) => {
    const invoice = await tx.subscriptionInvoice.findFirst({
      where: { provider: "razorpay", providerInvoiceId: payment.orderId },
      select: {
        id: true,
        status: true,
        amountMinor: true,
        currency: true,
        targetPlanId: true,
        targetPlan: { select: { id: true, key: true, isActive: true } },
        subscription: {
          select: {
            id: true,
            companyId: true,
            planId: true,
            plan: { select: { key: true } },
          },
        },
      },
    });

    // A payment for an order we never created. Nothing to do, and nothing to
    // guess at — recorded and left alone.
    if (!invoice) return { outcome: "UNKNOWN_ORDER" };

    const companyId = invoice.subscription.companyId;

    if (invoice.status === InvoiceStatus.PAID) {
      return { outcome: "ALREADY_PAID", invoiceId: invoice.id, companyId };
    }

    // The check that stops somebody paying ₹1 for a ₹5,000 plan. Both sides
    // are integers in paise, so this is an exact comparison and not a
    // tolerance.
    if (
      payment.amountMinor !== invoice.amountMinor ||
      payment.currency !== invoice.currency
    ) {
      await tx.subscriptionInvoice.update({
        where: { id: invoice.id },
        data: {
          status: InvoiceStatus.FAILED,
          providerPaymentId: payment.id,
          failureReason: `Paid ${payment.amountMinor} ${payment.currency}, expected ${invoice.amountMinor} ${invoice.currency}.`,
        },
      });
      return { outcome: "AMOUNT_MISMATCH", invoiceId: invoice.id, companyId };
    }

    // Only "captured" is money in the merchant's account. "authorized" means a
    // hold that may still expire, and treating it as payment would grant a
    // plan against money that never arrives.
    if (payment.status !== "captured") {
      return { outcome: "NOT_CAPTURED", invoiceId: invoice.id, companyId };
    }

    await tx.subscriptionInvoice.update({
      where: { id: invoice.id },
      data: {
        status: InvoiceStatus.PAID,
        providerPaymentId: payment.id,
        paidAt: payment.capturedAt ?? new Date(),
        failureReason: null,
      },
    });

    // The plan this invoice was raised for, named on the invoice when the
    // checkout opened. Nothing about which plan somebody bought is read out of
    // the webhook payload: that is the provider's data, and this is our
    // decision about what they are entitled to.
    const plan = invoice.targetPlan;

    if (plan && plan.isActive && plan.id !== invoice.subscription.planId) {
      await tx.subscription.update({
        where: { id: invoice.subscription.id },
        data: {
          planId: plan.id,
          status: "ACTIVE",
          provider: "razorpay",
        },
      });
      return {
        outcome: `UPGRADED_TO_${plan.key.toUpperCase()}`,
        invoiceId: invoice.id,
        companyId,
      };
    }

    return { outcome: "PAID", invoiceId: invoice.id, companyId };
  });
}

/** A failed payment: record why, and change nothing about the plan. */
async function applyFailure(payment: ProviderPayment): Promise<ApplyResult> {
  if (!payment.orderId) return { outcome: "NO_ORDER_ON_PAYMENT" };

  const invoice = await prisma.subscriptionInvoice.findFirst({
    where: { provider: "razorpay", providerInvoiceId: payment.orderId },
    select: {
      id: true,
      status: true,
      subscription: { select: { companyId: true } },
    },
  });
  if (!invoice) return { outcome: "UNKNOWN_ORDER" };

  // A failure after a capture is out-of-order delivery, not a reversal. The
  // paid invoice stands; a genuine reversal arrives as a refund.
  if (invoice.status === InvoiceStatus.PAID) {
    return {
      outcome: "FAILURE_AFTER_PAYMENT_IGNORED",
      invoiceId: invoice.id,
      companyId: invoice.subscription.companyId,
    };
  }

  await prisma.subscriptionInvoice.update({
    where: { id: invoice.id },
    data: {
      status: InvoiceStatus.FAILED,
      providerPaymentId: payment.id,
      failureReason:
        payment.errorDescription ?? "The payment was not completed.",
    },
  });

  await recordAuditLog({
    action: "billing.payment_failed",
    module: "BILLING",
    companyId: invoice.subscription.companyId,
    entityType: "SubscriptionInvoice",
    entityId: invoice.id,
    metadata: { paymentId: payment.id },
  });

  return {
    outcome: "FAILED",
    invoiceId: invoice.id,
    companyId: invoice.subscription.companyId,
  };
}
