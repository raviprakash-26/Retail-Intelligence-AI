import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db";
import {
  evaluate,
  UNLIMITED,
  type Entitlements,
  type SubscriptionStatusKey,
} from "@/lib/billing/entitlements";
import type { FeatureKey, PlanLimits } from "@/lib/billing/plans";

/**
 * What this business's subscription entitles it to, resolved once per request.
 *
 * Every gate in the product reads this. The navigation marks what a plan does
 * not include, but marking is presentation: the page and the server action
 * behind it check here as well, because a link that is merely hidden is not a
 * lock. Anybody can type a URL.
 *
 * A company with no subscription row at all is treated as having nothing —
 * never as having everything. Missing data is the one case where the generous
 * reading is the dangerous one.
 */

const NO_LIMITS: PlanLimits = {
  users: UNLIMITED,
  branches: UNLIMITED,
  productsPerCompany: UNLIMITED,
  transactionsPerMonth: UNLIMITED,
  aiMessagesPerMonth: UNLIMITED,
  storageMb: UNLIMITED,
};

/** The state of a company that has no subscription row. */
function unsubscribed(): Entitlements {
  return {
    planKey: "none",
    planName: "No plan",
    status: "EXPIRED",
    features: new Set<FeatureKey>(),
    limits: { ...NO_LIMITS, users: 1, branches: 1 },
    readOnly: true,
    readOnlyReason:
      "There is no plan on this business yet. Everything already recorded stays readable and exportable; posting new entries needs one.",
    trialEndsAt: null,
    currentPeriodEnd: new Date().toISOString(),
    daysRemaining: 0,
  };
}

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string")
    : [];

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asBooleanRecord = (value: unknown): Record<string, boolean> =>
  Object.fromEntries(
    Object.entries(asRecord(value)).filter(
      ([, entry]) => typeof entry === "boolean",
    ),
  ) as Record<string, boolean>;

export async function getEntitlements(
  companyId: string,
  now?: Date,
): Promise<Entitlements> {
  const subscription = await prisma.subscription.findUnique({
    where: { companyId },
    select: {
      status: true,
      trialEndsAt: true,
      currentPeriodEnd: true,
      featureOverrides: true,
      limitOverrides: true,
      plan: {
        select: { key: true, name: true, features: true, limits: true },
      },
    },
  });

  if (!subscription) return unsubscribed();

  return evaluate({
    planKey: subscription.plan.key,
    planName: subscription.plan.name,
    status: subscription.status as SubscriptionStatusKey,
    planFeatures: asStringArray(subscription.plan.features),
    planLimits: asRecord(subscription.plan.limits),
    featureOverrides: asBooleanRecord(subscription.featureOverrides),
    limitOverrides: asRecord(subscription.limitOverrides),
    trialEndsAt: subscription.trialEndsAt,
    currentPeriodEnd: subscription.currentPeriodEnd,
    now,
  });
}

/**
 * The same thing, memoised for the current request.
 *
 * A page, its layout and three server components below it all ask; without this
 * that is four identical queries on every navigation.
 */
export const entitlementsFor = cache(
  async (companyId: string): Promise<Entitlements> =>
    getEntitlements(companyId),
);

export type UsageSnapshot = {
  /** Active members plus invitations sent and not yet accepted. */
  users: number;
  branches: number;
  productsPerCompany: number;
  transactionsPerMonth: number;
  aiMessagesPerMonth: number;
  /** The month the per-month figures cover. */
  periodStart: string;
  periodEnd: string;
};

/**
 * What the business has actually used.
 *
 * Counted from the records themselves rather than from a running total kept
 * alongside them. A counter that drifts from what is on the shelf is worse than
 * a query that takes a moment, and every one of these is indexed.
 */
export async function getUsage(
  companyId: string,
  now = new Date(),
): Promise<UsageSnapshot> {
  const periodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const periodEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  const month = { gte: periodStart, lt: periodEnd };

  const [
    members,
    pendingInvitations,
    branches,
    products,
    sales,
    purchases,
    expenses,
    messages,
  ] = await Promise.all([
    prisma.membership.count({ where: { companyId, status: "ACTIVE" } }),
    // An invitation is a seat somebody is about to take. Counting only
    // accepted ones would let a business on a two-seat plan invite twenty
    // people and be surprised on the day they all sign in.
    prisma.verificationToken.count({
      where: {
        companyId,
        purpose: "MEMBER_INVITATION",
        consumedAt: null,
        expiresAt: { gt: now },
      },
    }),
    prisma.branch.count({ where: { companyId, isActive: true } }),
    prisma.product.count({ where: { companyId, archivedAt: null } }),
    prisma.sale.count({ where: { companyId, createdAt: month } }),
    prisma.purchase.count({ where: { companyId, createdAt: month } }),
    prisma.expense.count({ where: { companyId, createdAt: month } }),
    prisma.aiMessage.count({
      where: { companyId, role: "USER", createdAt: month },
    }),
  ]);

  return {
    users: members + pendingInvitations,
    branches,
    productsPerCompany: products,
    // What a shopkeeper would call a transaction: something they entered.
    // Journal entries the engine posted behind each one are not counted twice.
    transactionsPerMonth: sales + purchases + expenses,
    aiMessagesPerMonth: messages,
    periodStart: periodStart.toISOString().slice(0, 10),
    periodEnd: new Date(periodEnd.getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10),
  };
}
