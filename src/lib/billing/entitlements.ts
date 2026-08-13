import type { FeatureKey, PlanLimits } from "@/lib/billing/plans";

/**
 * What a subscription actually entitles a business to.
 *
 * Two rules run through this file, and both are deliberate.
 *
 * The first: entitlements are data. A plan's features are a list on a row, not
 * a `plan === "business"` conditional, so packaging can change without a
 * deployment and a single customer can be given something without a special
 * case in the code.
 *
 * The second, and the one that matters more: **a business's books are its
 * own.** A subscription that lapses stops new entries being posted. It never
 * seals the ledger. Everything already recorded stays readable, printable and
 * exportable for as long as the account exists, because a shopkeeper who
 * stopped paying in March still has to file a return in July, and software that
 * holds their own accounting hostage to get them to pay is not something worth
 * building.
 */

/** `-1` means unlimited, everywhere. */
export const UNLIMITED = -1;

export type SubscriptionStatusKey =
  "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELLED" | "EXPIRED";

/**
 * How long a payment can be late before new entries stop.
 *
 * A failed card is usually a failed card, not a decision. Cutting a shop off
 * the same evening its bank declined a renewal would be punishing the
 * commonest, most innocent thing that happens in billing.
 */
export const GRACE_DAYS = 7;

export type Entitlements = {
  planKey: string;
  planName: string;
  status: SubscriptionStatusKey;
  features: ReadonlySet<FeatureKey>;
  limits: PlanLimits;
  /** True where the books may be read but nothing new may be posted. */
  readOnly: boolean;
  /** Why, in a sentence a shopkeeper would use. Null when nothing is wrong. */
  readOnlyReason: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string;
  /** Whole days until the trial or the period ends. Negative once past. */
  daysRemaining: number;
};

/** Statuses that still allow a transaction to be posted. */
const CAN_POST: ReadonlySet<SubscriptionStatusKey> = new Set([
  "TRIALING",
  "ACTIVE",
]);

export const READ_ONLY_REASON: Record<
  Exclude<SubscriptionStatusKey, "TRIALING" | "ACTIVE">,
  string
> = {
  PAST_DUE:
    "The last payment did not go through. Your books are all here and stay here — new entries start again as soon as the payment does.",
  CANCELLED:
    "This subscription has been cancelled. Everything already recorded stays readable and exportable; posting new entries needs an active plan.",
  EXPIRED:
    "The trial has ended. Everything you entered during it is still here and always will be; posting new entries needs a plan.",
};

/**
 * Whether a feature is included, after any per-tenant override.
 *
 * Overrides are how a business gets something its plan does not include —
 * a promise made by somebody in support, an early-access arrangement — without
 * a conditional in the code that nobody will remember to remove.
 */
export function resolveFeatures(params: {
  planFeatures: readonly string[];
  featureOverrides?: Record<string, boolean> | null;
}): Set<FeatureKey> {
  const features = new Set(params.planFeatures as FeatureKey[]);
  for (const [key, granted] of Object.entries(params.featureOverrides ?? {})) {
    if (granted) features.add(key as FeatureKey);
    else features.delete(key as FeatureKey);
  }
  return features;
}

const LIMIT_KEYS = [
  "users",
  "branches",
  "productsPerCompany",
  "transactionsPerMonth",
  "aiMessagesPerMonth",
  "storageMb",
] as const satisfies readonly (keyof PlanLimits)[];

/** Limits from the plan, with any per-tenant override laid over the top. */
export function resolveLimits(params: {
  planLimits: Partial<Record<string, unknown>>;
  limitOverrides?: Partial<Record<string, unknown>> | null;
}): PlanLimits {
  const read = (key: keyof PlanLimits): number => {
    const override = params.limitOverrides?.[key];
    if (typeof override === "number") return override;
    const planValue = params.planLimits[key];
    // A limit the plan does not name is not a limit of zero. Reading a missing
    // key as nil would lock a business out of a feature its plan includes.
    return typeof planValue === "number" ? planValue : UNLIMITED;
  };

  return Object.fromEntries(
    LIMIT_KEYS.map((key) => [key, read(key)]),
  ) as PlanLimits;
}

export function hasFeature(
  entitlements: Pick<Entitlements, "features">,
  feature: FeatureKey,
): boolean {
  return entitlements.features.has(feature);
}

/**
 * Whether one more of something is allowed.
 *
 * Asked before the thing is created, so `current` is the count as it stands.
 * An unlimited or negative limit never blocks anything.
 */
export function isWithinLimit(limit: number, current: number): boolean {
  if (limit === UNLIMITED || limit < 0) return true;
  return current < limit;
}

/** How much of an allowance is used, for a bar somebody has to believe. */
export function usageShare(limit: number, current: number): number | null {
  if (limit === UNLIMITED || limit <= 0) return null;
  return Math.min(100, Math.round((current / limit) * 100));
}

const DAY = 86_400_000;

export function daysUntil(when: Date, now: Date): number {
  return Math.ceil((when.getTime() - now.getTime()) / DAY);
}

/**
 * The effective state of a subscription at a moment in time.
 *
 * Status alone is not enough: a subscription can say ACTIVE and have run past
 * the end of the period it was paid for, and one that says PAST_DUE may still
 * be inside its grace. Both are worked out here rather than in each caller, so
 * there is one answer to "can this business post an entry right now".
 */
export function evaluate(params: {
  planKey: string;
  planName: string;
  status: SubscriptionStatusKey;
  planFeatures: readonly string[];
  planLimits: Partial<Record<string, unknown>>;
  featureOverrides?: Record<string, boolean> | null;
  limitOverrides?: Partial<Record<string, unknown>> | null;
  trialEndsAt?: Date | null;
  currentPeriodEnd: Date;
  now?: Date;
}): Entitlements {
  const now = params.now ?? new Date();
  const features = resolveFeatures(params);
  const limits = resolveLimits(params);

  const endsAt = params.trialEndsAt ?? params.currentPeriodEnd;
  const daysRemaining = daysUntil(endsAt, now);

  let status = params.status;

  // A trial that ran out is expired whatever the row says. Nothing sweeps these
  // rows at midnight, and a subscription that is only correct after a job has
  // run is one that is wrong every night.
  if (status === "TRIALING" && params.trialEndsAt && daysRemaining < 0) {
    status = "EXPIRED";
  }

  // Likewise a period that has ended without a renewal being recorded.
  if (status === "ACTIVE" && daysUntil(params.currentPeriodEnd, now) < 0) {
    status = "PAST_DUE";
  }

  const overdueDays =
    status === "PAST_DUE" ? -daysUntil(params.currentPeriodEnd, now) : 0;
  const inGrace = status === "PAST_DUE" && overdueDays <= GRACE_DAYS;

  const readOnly = !CAN_POST.has(status) && !inGrace;

  return {
    planKey: params.planKey,
    planName: params.planName,
    status,
    features,
    limits,
    readOnly,
    readOnlyReason:
      readOnly && status !== "TRIALING" && status !== "ACTIVE"
        ? READ_ONLY_REASON[status]
        : null,
    trialEndsAt: params.trialEndsAt?.toISOString() ?? null,
    currentPeriodEnd: params.currentPeriodEnd.toISOString(),
    daysRemaining,
  };
}

/**
 * What is missing, said as the thing rather than as the key.
 *
 * A message that names an internal identifier tells the reader they have hit a
 * wall without telling them which one.
 */
export const FEATURE_LABEL: Record<FeatureKey, string> = {
  "core.transactions": "recording sales, purchases and expenses",
  "accounting.basic": "the accounting ledger",
  "accounting.statements": "the financial statements",
  inventory: "inventory",
  "gst.preparation": "GST preparation",
  "tax.preparation": "income tax preparation",
  analytics: "analytics",
  "ai.accountant": "the AI Accountant",
  "ai.auditor": "the AI Auditor",
  "ai.advisor": "the AI Business Advisor",
  forecasting: "forecasting",
  "multi.branch": "more than one branch",
  "permissions.advanced": "custom roles",
  "support.priority": "priority support",
  "reports.export": "exports",
};

export const LIMIT_LABEL: Record<keyof PlanLimits, string> = {
  users: "team members",
  branches: "branches",
  productsPerCompany: "products",
  transactionsPerMonth: "transactions this month",
  aiMessagesPerMonth: "AI messages this month",
  storageMb: "megabytes of storage",
};
