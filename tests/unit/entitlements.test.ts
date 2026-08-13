import { describe, expect, it } from "vitest";
import {
  daysUntil,
  evaluate,
  FEATURE_LABEL,
  GRACE_DAYS,
  hasFeature,
  isWithinLimit,
  LIMIT_LABEL,
  READ_ONLY_REASON,
  resolveFeatures,
  resolveLimits,
  UNLIMITED,
  usageShare,
} from "@/lib/billing/entitlements";
import { FEATURE, PLAN_DEFINITIONS } from "@/lib/billing/plans";

/**
 * What a subscription entitles a business to.
 *
 * The arithmetic is easy. The part worth protecting is what happens when
 * somebody stops paying: their own books stay readable. Software that seals a
 * shopkeeper's ledger to collect a debt is not something worth building, and
 * the tests say so out loud so that nobody quietly changes it.
 */

const DAY = 86_400_000;
const NOW = new Date("2026-08-13T10:00:00.000Z");
const inDays = (days: number): Date => new Date(NOW.getTime() + days * DAY);

const base = {
  planKey: "professional",
  planName: "Professional",
  planFeatures: [FEATURE.INVENTORY, FEATURE.ANALYTICS],
  planLimits: { users: 5, branches: 1, transactionsPerMonth: 2000 },
  currentPeriodEnd: inDays(20),
  now: NOW,
};

describe("features", () => {
  it("come from the plan", () => {
    const result = evaluate({ ...base, status: "ACTIVE" });
    expect(hasFeature(result, FEATURE.INVENTORY)).toBe(true);
    expect(hasFeature(result, FEATURE.AI_AUDITOR)).toBe(false);
  });

  it("can be granted to one business without a conditional in the code", () => {
    const features = resolveFeatures({
      planFeatures: [FEATURE.INVENTORY],
      featureOverrides: { [FEATURE.AI_AUDITOR]: true },
    });
    expect(features.has(FEATURE.AI_AUDITOR)).toBe(true);
  });

  it("can be taken away from one business the same way", () => {
    const features = resolveFeatures({
      planFeatures: [FEATURE.INVENTORY, FEATURE.ANALYTICS],
      featureOverrides: { [FEATURE.ANALYTICS]: false },
    });
    expect(features.has(FEATURE.ANALYTICS)).toBe(false);
    expect(features.has(FEATURE.INVENTORY)).toBe(true);
  });

  it("has a plain name for every one of them", () => {
    // A message that names an internal key tells somebody they have hit a wall
    // without telling them which one.
    for (const plan of PLAN_DEFINITIONS) {
      for (const feature of plan.features) {
        expect(FEATURE_LABEL[feature], feature).toBeTruthy();
      }
    }
  });
});

describe("limits", () => {
  it("come from the plan and can be overridden per business", () => {
    const limits = resolveLimits({
      planLimits: { users: 5, branches: 1 },
      limitOverrides: { users: 12 },
    });
    expect(limits.users).toBe(12);
    expect(limits.branches).toBe(1);
  });

  it("treat a limit the plan does not name as no limit, never as nil", () => {
    // Reading a missing key as zero would lock a business out of something its
    // plan includes, which is the worst possible reading of missing data.
    const limits = resolveLimits({ planLimits: { users: 5 } });
    expect(limits.storageMb).toBe(UNLIMITED);
    expect(isWithinLimit(limits.storageMb, 900_000)).toBe(true);
  });

  it("allow one more until the allowance is used", () => {
    expect(isWithinLimit(2, 1)).toBe(true);
    expect(isWithinLimit(2, 2)).toBe(false);
    expect(isWithinLimit(UNLIMITED, 10_000)).toBe(true);
  });

  it("show a share only where there is an allowance to show", () => {
    expect(usageShare(10, 3)).toBe(30);
    expect(usageShare(UNLIMITED, 3)).toBeNull();
    expect(usageShare(0, 3)).toBeNull();
  });

  it("do not report more than full", () => {
    expect(usageShare(10, 40)).toBe(100);
  });

  it("has a plain name for every limit", () => {
    for (const key of Object.keys(PLAN_DEFINITIONS[0]?.limits ?? {})) {
      expect(LIMIT_LABEL[key as keyof typeof LIMIT_LABEL], key).toBeTruthy();
    }
  });
});

describe("a subscription in good standing", () => {
  it("can post while trialing", () => {
    const result = evaluate({
      ...base,
      status: "TRIALING",
      trialEndsAt: inDays(6),
    });
    expect(result.readOnly).toBe(false);
    expect(result.daysRemaining).toBe(6);
  });

  it("can post while active", () => {
    expect(evaluate({ ...base, status: "ACTIVE" }).readOnly).toBe(false);
  });
});

describe("a subscription that has run out", () => {
  it("expires a trial the day it ends, without waiting for a job", () => {
    // A subscription that is only correct after a nightly sweep has run is one
    // that is wrong every night.
    const result = evaluate({
      ...base,
      status: "TRIALING",
      trialEndsAt: inDays(-1),
    });
    expect(result.status).toBe("EXPIRED");
    expect(result.readOnly).toBe(true);
  });

  it("treats a period that ended without a renewal as late, not as active", () => {
    const result = evaluate({
      ...base,
      status: "ACTIVE",
      currentPeriodEnd: inDays(-2),
    });
    expect(result.status).toBe("PAST_DUE");
  });

  it("gives a failed payment a few days before anything stops", () => {
    // A declined card is usually a declined card, not a decision.
    const result = evaluate({
      ...base,
      status: "PAST_DUE",
      currentPeriodEnd: inDays(-(GRACE_DAYS - 1)),
    });
    expect(result.readOnly).toBe(false);
  });

  it("stops new entries once the grace is used up", () => {
    const result = evaluate({
      ...base,
      status: "PAST_DUE",
      currentPeriodEnd: inDays(-(GRACE_DAYS + 1)),
    });
    expect(result.readOnly).toBe(true);
    expect(result.readOnlyReason).toMatch(/stay here/i);
  });

  it("never claims the books are gone", () => {
    // The one promise this file makes. Every reason a business is stopped from
    // posting says, in the same breath, that what they already recorded is
    // still theirs.
    for (const reason of Object.values(READ_ONLY_REASON)) {
      expect(reason).toMatch(
        /stays? (readable|here)|still here|all here|exportable/i,
      );
      expect(reason).not.toMatch(/delete|lost|removed|no longer available/i);
    }
  });

  it("stops posting on a cancelled subscription but says the books remain", () => {
    const result = evaluate({
      ...base,
      status: "CANCELLED",
      currentPeriodEnd: inDays(-1),
    });
    expect(result.readOnly).toBe(true);
    expect(result.readOnlyReason).toMatch(/readable and exportable/i);
  });

  it("keeps the features it had, so nothing disappears from the page", () => {
    // Read-only is about writing. A business looking at its own inventory
    // history after cancelling should not find the page gone as well.
    const result = evaluate({
      ...base,
      status: "EXPIRED",
      trialEndsAt: inDays(-5),
    });
    expect(hasFeature(result, FEATURE.INVENTORY)).toBe(true);
  });
});

describe("counting the days", () => {
  it("counts a part day as a day, so 'ends tomorrow' is never shown as today", () => {
    expect(daysUntil(new Date(NOW.getTime() + DAY / 2), NOW)).toBe(1);
  });

  it("goes negative once it is past", () => {
    expect(daysUntil(new Date(NOW.getTime() - 2 * DAY), NOW)).toBe(-2);
  });
});
