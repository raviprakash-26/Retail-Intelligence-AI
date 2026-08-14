import "server-only";
import { SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { LIMIT_LABEL, usageShare, UNLIMITED } from "@/lib/billing/entitlements";
import type { PlanLimits } from "@/lib/billing/plans";
import {
  getEntitlements,
  getUsage,
  type UsageSnapshot,
} from "@/server/billing/entitlement-service";
import { paymentsStatus, requiresPayment } from "@/server/billing/payments";
import { recordAuditLog } from "@/server/audit/audit-log";
import type { Entitlements } from "@/lib/billing/entitlements";

/**
 * The subscription itself: what it is, what it costs, and what may change.
 *
 * A plan change that costs nothing — moving to something cheaper, or
 * cancelling — happens here and now. A plan change that costs money cannot,
 * because this build has no way to take money, and it says so rather than
 * quietly granting the upgrade or quietly recording a payment that never
 * happened.
 */

export type PlanOption = {
  id: string;
  key: string;
  name: string;
  tagline: string | null;
  priceMinor: number;
  currency: string;
  interval: string;
  features: string[];
  limits: Partial<PlanLimits>;
  isCurrent: boolean;
  /** True where moving to it would need a payment this build cannot take. */
  needsPayment: boolean;
};

export type UsageLine = {
  key: keyof PlanLimits;
  label: string;
  used: number;
  limit: number;
  sharePercent: number | null;
  /** True once the allowance is used up: additions stop, records stay. */
  exhausted: boolean;
};

export type BillingInvoice = {
  id: string;
  number: string;
  status: string;
  amountMinor: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  paidAt: string | null;
  failureReason: string | null;
};

export type BillingOverview = {
  entitlements: Entitlements;
  usage: UsageSnapshot;
  lines: UsageLine[];
  plans: PlanOption[];
  invoices: BillingInvoice[];
  cancelAtPeriodEnd: boolean;
  currentPriceMinor: number;
  currency: string;
  payments: ReturnType<typeof paymentsStatus>;
};

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string")
    : [];

const asLimits = (value: unknown): Partial<PlanLimits> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Partial<PlanLimits>)
    : {};

/** The countable allowances. Storage is not counted yet, so it is not shown. */
const COUNTED: readonly (keyof PlanLimits)[] = [
  "users",
  "branches",
  "productsPerCompany",
  "transactionsPerMonth",
  "aiMessagesPerMonth",
];

export async function getBillingOverview(
  companyId: string,
): Promise<BillingOverview> {
  const [entitlements, usage, subscription, plans] = await Promise.all([
    getEntitlements(companyId),
    getUsage(companyId),
    prisma.subscription.findUnique({
      where: { companyId },
      select: {
        cancelAtPeriodEnd: true,
        plan: { select: { priceMinor: true, currency: true } },
        invoices: {
          orderBy: { createdAt: "desc" },
          take: 12,
          select: {
            id: true,
            number: true,
            status: true,
            amountMinor: true,
            currency: true,
            periodStart: true,
            periodEnd: true,
            paidAt: true,
            failureReason: true,
          },
        },
      },
    }),
    prisma.subscriptionPlan.findMany({
      where: { isActive: true, isPublic: true },
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        key: true,
        name: true,
        tagline: true,
        priceMinor: true,
        currency: true,
        interval: true,
        features: true,
        limits: true,
      },
    }),
  ]);

  const currentPriceMinor = subscription?.plan.priceMinor ?? 0;

  const lines: UsageLine[] = COUNTED.map((key) => {
    const limit = entitlements.limits[key];
    const used = usage[key as keyof UsageSnapshot];
    const usedNumber = typeof used === "number" ? used : 0;
    return {
      key,
      label: LIMIT_LABEL[key],
      used: usedNumber,
      limit,
      sharePercent: usageShare(limit, usedNumber),
      exhausted: limit !== UNLIMITED && limit >= 0 && usedNumber >= limit,
    };
  });

  return {
    entitlements,
    usage,
    lines,
    plans: plans.map((plan) => ({
      id: plan.id,
      key: plan.key,
      name: plan.name,
      tagline: plan.tagline,
      priceMinor: plan.priceMinor,
      currency: plan.currency,
      interval: plan.interval,
      features: asStringArray(plan.features),
      limits: asLimits(plan.limits),
      isCurrent: plan.key === entitlements.planKey,
      needsPayment: requiresPayment({
        currentPriceMinor,
        targetPriceMinor: plan.priceMinor,
      }),
    })),
    invoices: (subscription?.invoices ?? []).map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      amountMinor: invoice.amountMinor,
      currency: invoice.currency,
      periodStart: isoDay(invoice.periodStart),
      periodEnd: isoDay(invoice.periodEnd),
      paidAt: invoice.paidAt?.toISOString() ?? null,
      failureReason: invoice.failureReason,
    })),
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    currentPriceMinor,
    currency: subscription?.plan.currency ?? "INR",
    payments: paymentsStatus(),
  };
}

export type PlanChangeResult =
  | { changed: true; planName: string; overLimit: UsageLine[] }
  | { changed: false; reason: string };

/**
 * Moving between plans.
 *
 * Downwards and sideways happen immediately: nothing has to be collected, so
 * there is nothing to wait for. Upwards needs a payment, and this build cannot
 * take one — so it refuses and says why, rather than granting an upgrade nobody
 * paid for or writing a paid invoice no bank has seen.
 *
 * A downgrade is never blocked by what the business has already recorded. If
 * they have five users and move to a plan with two, all five keep working and
 * nothing is deleted; adding a sixth is what stops. Locking somebody out of
 * their own records to enforce a price is not a thing this does.
 */
export async function changePlan(params: {
  companyId: string;
  planKey: string;
  userId: string;
  actorEmail: string;
}): Promise<PlanChangeResult> {
  const [subscription, target] = await Promise.all([
    prisma.subscription.findUnique({
      where: { companyId: params.companyId },
      select: {
        id: true,
        planId: true,
        status: true,
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
        isActive: true,
      },
    }),
  ]);

  if (!subscription) {
    return { changed: false, reason: "This business has no subscription yet." };
  }
  if (!target || !target.isActive) {
    return { changed: false, reason: "That plan is not available." };
  }
  if (target.id === subscription.planId) {
    return { changed: false, reason: "That is already the current plan." };
  }

  if (
    requiresPayment({
      currentPriceMinor: subscription.plan.priceMinor,
      targetPriceMinor: target.priceMinor,
    })
  ) {
    const payments = paymentsStatus();
    if (!payments.available) {
      return {
        changed: false,
        reason: `Moving to ${target.name} costs more than your current plan, so it needs a payment. ${payments.reason}`,
      };
    }
    return {
      changed: false,
      reason:
        "Taking the payment for an upgrade has not been built yet, and nothing here will pretend to have taken one.",
    };
  }

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { planId: target.id },
  });

  await recordAuditLog({
    action: "billing.plan_changed",
    module: "BILLING",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "Subscription",
    entityId: subscription.id,
    metadata: { from: subscription.plan.key, to: target.key },
  });

  // What the new allowances no longer cover. Said plainly rather than
  // discovered later by somebody who cannot add a user.
  const overview = await getBillingOverview(params.companyId);

  return {
    changed: true,
    planName: target.name,
    overLimit: overview.lines.filter((line) => line.exhausted),
  };
}

/**
 * Cancelling.
 *
 * At the end of the period by default: the business has paid for that period
 * and keeps it. Nothing about the books changes on cancellation beyond the
 * ability to post new entries once the period runs out.
 */
export async function cancelSubscription(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  immediately?: boolean;
}): Promise<boolean> {
  const subscription = await prisma.subscription.findUnique({
    where: { companyId: params.companyId },
    select: { id: true },
  });
  if (!subscription) return false;

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: params.immediately
      ? {
          status: SubscriptionStatus.CANCELLED,
          cancelAtPeriodEnd: false,
          cancelledAt: new Date(),
        }
      : { cancelAtPeriodEnd: true },
  });

  await recordAuditLog({
    action: "billing.cancelled",
    module: "BILLING",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "Subscription",
    entityId: subscription.id,
    metadata: { immediately: params.immediately === true },
  });

  return true;
}

/** Undoing a cancellation that has not taken effect yet. */
export async function resumeSubscription(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
}): Promise<boolean> {
  const subscription = await prisma.subscription.findUnique({
    where: { companyId: params.companyId },
    select: { id: true, cancelAtPeriodEnd: true, status: true },
  });
  if (!subscription || !subscription.cancelAtPeriodEnd) return false;

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { cancelAtPeriodEnd: false, cancelledAt: null },
  });

  await recordAuditLog({
    action: "billing.cancellation_withdrawn",
    module: "BILLING",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "Subscription",
    entityId: subscription.id,
  });

  return true;
}
