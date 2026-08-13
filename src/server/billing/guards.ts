import "server-only";
import {
  FEATURE_LABEL,
  isWithinLimit,
  LIMIT_LABEL,
  type Entitlements,
} from "@/lib/billing/entitlements";
import {
  PLAN_DEFINITIONS,
  type FeatureKey,
  type PlanLimits,
} from "@/lib/billing/plans";
import { getCompanyContext, type CompanyContext } from "@/server/auth/context";
import {
  ACTION_ERROR,
  fail,
  type ActionResult,
} from "@/server/auth/action-result";
import { unauthorized } from "next/navigation";
import {
  entitlementsFor,
  getUsage,
} from "@/server/billing/entitlement-service";

/**
 * The gates a subscription puts in front of an operation.
 *
 * Three separate questions, deliberately not merged:
 *
 *   • is this feature in the plan
 *   • may this business post anything at all right now
 *   • is there room inside a numeric allowance for one more
 *
 * All three are asked on the server, in the action that does the work. The
 * navigation marks locked items and the pages render an explanation, but both
 * are presentation. A control that is merely hidden is not a lock — anybody can
 * type a URL or post the form themselves.
 */

export class FeatureNotIncludedError extends Error {
  constructor(readonly feature: FeatureKey) {
    super(`Not included in this plan: ${feature}`);
    this.name = "FeatureNotIncludedError";
  }

  /** What to show a shopkeeper: the thing, not the key. */
  get readable(): string {
    return `${FEATURE_LABEL[this.feature] ?? "This"} is not included in your current plan.`;
  }
}

export class SubscriptionReadOnlyError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "SubscriptionReadOnlyError";
  }
}

export class LimitReachedError extends Error {
  constructor(
    readonly limitKey: keyof PlanLimits,
    readonly limit: number,
    readonly current: number,
  ) {
    super(`Limit reached: ${limitKey} (${current}/${limit})`);
    this.name = "LimitReachedError";
  }

  get readable(): string {
    return `Your plan includes ${this.limit} ${LIMIT_LABEL[this.limitKey]}, and ${this.current} are in use.`;
  }
}

export type FeatureGate = {
  included: boolean;
  entitlements: Entitlements;
  /** The cheapest plan that has it, for the locked page to name. */
  availableOn: string | null;
};

/** For a page: whether to render the module or the explanation. */
export async function featureGate(
  companyId: string,
  feature: FeatureKey,
): Promise<FeatureGate> {
  const entitlements = await entitlementsFor(companyId);
  return {
    included: entitlements.features.has(feature),
    entitlements,
    availableOn: entitlements.features.has(feature)
      ? null
      : cheapestPlanWith(feature),
  };
}

/**
 * The least expensive plan that includes something.
 *
 * Read from the seed definitions rather than the database: this is a sentence
 * on a locked page, and one more query on every gated page to render marketing
 * copy is not worth it. A plan renamed in the admin panel shows its old name
 * here until the definitions are updated — a small, visible inaccuracy in
 * exchange for not querying, and never used for an entitlement decision.
 */
function cheapestPlanWith(feature: FeatureKey): string | null {
  const candidates = PLAN_DEFINITIONS.filter((plan) =>
    plan.features.includes(feature),
  ).sort((a, b) => a.priceMinor - b.priceMinor);
  return candidates[0]?.name ?? null;
}

/**
 * For an action: the context, or an error naming what is missing.
 *
 * Returns the context for the same reason `assertPermission` does — so the
 * caller takes `companyId` from a trusted source rather than from the form.
 */
export async function assertFeature(
  feature: FeatureKey,
): Promise<CompanyContext> {
  const context = await getCompanyContext();
  if (!context) unauthorized();

  const entitlements = await entitlementsFor(context.company.id);
  if (!entitlements.features.has(feature)) {
    throw new FeatureNotIncludedError(feature);
  }
  return context;
}

/**
 * Whether anything new may be recorded.
 *
 * This is the only gate a lapsed subscription closes. Reading, printing and
 * exporting what is already there stays open, because those books belong to the
 * business rather than to the platform, and a shopkeeper who stopped paying in
 * March still has a return to file in July.
 */
export async function assertCanPost(): Promise<CompanyContext> {
  const context = await getCompanyContext();
  if (!context) unauthorized();

  const entitlements = await entitlementsFor(context.company.id);
  if (entitlements.readOnly) {
    throw new SubscriptionReadOnlyError(
      entitlements.readOnlyReason ??
        "This subscription is not active. Everything already recorded stays readable and exportable.",
    );
  }
  return context;
}

/**
 * Whether there is room for one more.
 *
 * The count is taken now rather than trusted from a running total, because a
 * counter that has drifted from the records is how a business ends up unable to
 * add the third of the three users it is paying for.
 */
export async function assertWithinLimit(
  companyId: string,
  limitKey: keyof PlanLimits,
): Promise<void> {
  const [entitlements, usage] = await Promise.all([
    entitlementsFor(companyId),
    getUsage(companyId),
  ]);

  const limit = entitlements.limits[limitKey];
  const current = usage[limitKey as keyof typeof usage];
  if (typeof current !== "number") return;

  if (!isWithinLimit(limit, current)) {
    throw new LimitReachedError(limitKey, limit, current);
  }
}

/**
 * Turns a billing refusal into a sentence for a form.
 *
 * Returns null for anything else, so a caller can rethrow what it does not
 * understand rather than swallowing a real bug as a billing message.
 */
export function billingMessage(error: unknown): string | null {
  if (error instanceof FeatureNotIncludedError) return error.readable;
  if (error instanceof LimitReachedError) return error.readable;
  if (error instanceof SubscriptionReadOnlyError) return error.message;
  return null;
}

/**
 * The billing check a server action makes before it writes anything.
 *
 * Returns a failed `ActionResult` to render, or null to carry on — actions in
 * this codebase do not throw for outcomes a form has to display, and "your
 * plan does not include this" is an outcome rather than an exception.
 *
 * Checked in the order a person would ask: is this thing in the plan at all,
 * is the subscription in a state where anything may be recorded, and is there
 * room inside the allowance for one more.
 */
export async function billingRefusal(
  companyId: string,
  options: { feature?: FeatureKey; limit?: keyof PlanLimits } = {},
): Promise<ActionResult<never> | null> {
  const entitlements = await entitlementsFor(companyId);

  if (options.feature && !entitlements.features.has(options.feature)) {
    return fail(new FeatureNotIncludedError(options.feature).readable, {
      code: ACTION_ERROR.FEATURE_NOT_INCLUDED,
    });
  }

  if (entitlements.readOnly) {
    return fail(
      entitlements.readOnlyReason ??
        "This subscription is not active. Everything already recorded stays readable and exportable.",
      { code: ACTION_ERROR.SUBSCRIPTION_READ_ONLY },
    );
  }

  if (options.limit) {
    const usage = await getUsage(companyId);
    const limit = entitlements.limits[options.limit];
    const current = usage[options.limit as keyof typeof usage];
    if (typeof current === "number" && !isWithinLimit(limit, current)) {
      return fail(
        new LimitReachedError(options.limit, limit, current).readable,
        {
          code: ACTION_ERROR.PLAN_LIMIT_REACHED,
        },
      );
    }
  }

  return null;
}
