import type { PrismaClient } from "@prisma/client";
import { BillingInterval } from "@prisma/client";
import { PLAN_DEFINITIONS } from "@/lib/billing/plans";
import { withPlatformSeedLock } from "./lock";

/**
 * Seeds the subscription plans.
 *
 * These rows are the runtime source of truth for entitlements — the platform
 * admin panel edits them, and the entitlement check reads them. The constants
 * in `@/lib/billing/plans` are only the initial values.
 */
export async function seedSubscriptionPlans(prisma: PrismaClient) {
  // Prisma's upsert is a read followed by a write, not an ON CONFLICT, so it
  // races against a concurrent copy exactly as the role seeding does.
  return withPlatformSeedLock(prisma, async (tx) => {
    for (const plan of PLAN_DEFINITIONS) {
      const data = {
        name: plan.name,
        tagline: plan.tagline,
        description: plan.description,
        priceMinor: plan.priceMinor,
        currency: plan.currency,
        interval: BillingInterval[plan.interval],
        trialDays: plan.trialDays,
        features: [...plan.features],
        limits: { ...plan.limits },
        sortOrder: plan.sortOrder,
        isPublic: true,
        isActive: true,
      };

      await tx.subscriptionPlan.upsert({
        where: { key: plan.key },
        create: { key: plan.key, ...data },
        update: data,
      });
    }

    return { plans: PLAN_DEFINITIONS.length };
  });
}
