import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SubscriptionStatus } from "@prisma/client";
import { FEATURE } from "@/lib/billing/plans";
import { GRACE_DAYS } from "@/lib/billing/entitlements";
import type { RegisterInput } from "@/lib/validation/auth";
import { registerOwner } from "@/server/auth/registration";
import {
  getEntitlements,
  getUsage,
} from "@/server/billing/entitlement-service";
import {
  cancelSubscription,
  changePlan,
  getBillingOverview,
  resumeSubscription,
} from "@/server/billing/subscription-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Subscriptions, against the real tables.
 *
 * The rule being protected here is the one that matters when somebody stops
 * paying: their books stay theirs. Everything else — features, allowances,
 * plan changes — is packaging, and packaging must never reach into a ledger.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

const DAY = 86_400_000;

function registrationInput(
  email: string,
  overrides: { openingCashBalance?: number } = {},
): RegisterInput {
  return {
    account: {
      fullName: "Ravi Prakash",
      email,
      mobile: "9845012345",
      password: "MountainRiver42!",
      confirmPassword: "MountainRiver42!",
      acceptTerms: true,
    },
    business: {
      businessName: `Billing ${uniqueSlug("Mart")}`,
      businessType: "SOLE_PROPRIETORSHIP",
      gstRegistration: "REGULAR",
      gstin: "29AAAPR1234K1ZP",
      pan: "AAAPR1234K",
      addressLine1: "42 Avenue Road",
      city: "Bengaluru",
      stateCode: "29",
      pincode: "560053",
    },
    accounting: {
      fiscalYearStartMonth: 4,
      currency: "INR",
      openingCashBalance: overrides.openingCashBalance ?? 0,
      openingBankBalance: 0,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

async function createCompany(overrides: { openingCashBalance?: number } = {}) {
  const email = `billing-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email, overrides));
  createdCompanies.push(result.companyId);
  return result;
}

beforeAll(async () => {
  await ensurePlatformData();
}, 60_000);

afterAll(async () => {
  for (const companyId of createdCompanies) await purgeTestCompany(companyId);
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
}, 60_000);

describe("a business that has just registered", () => {
  it("is on a trial that can post", async () => {
    const { companyId } = await createCompany();
    const entitlements = await getEntitlements(companyId);

    expect(entitlements.status).toBe("TRIALING");
    expect(entitlements.readOnly).toBe(false);
    expect(entitlements.daysRemaining).toBeGreaterThan(0);
  }, 60_000);

  it("gets the features its plan lists, and not the others", async () => {
    const { companyId } = await createCompany();
    const entitlements = await getEntitlements(companyId);

    expect(entitlements.features.has(FEATURE.CORE_TRANSACTIONS)).toBe(true);
    // The trial plan is Professional, which does not include the auditor.
    expect(entitlements.features.has(FEATURE.AI_AUDITOR)).toBe(false);
  }, 60_000);

  it("counts one owner and one branch as used", async () => {
    const { companyId } = await createCompany();
    const usage = await getUsage(companyId);

    expect(usage.users).toBe(1);
    expect(usage.branches).toBe(1);
    expect(usage.transactionsPerMonth).toBe(0);
  }, 60_000);
});

describe("a subscription that lapses", () => {
  it("stops new entries once the grace has run out", async () => {
    const { companyId } = await createCompany();
    await prisma.subscription.update({
      where: { companyId },
      data: {
        status: SubscriptionStatus.PAST_DUE,
        currentPeriodEnd: new Date(Date.now() - (GRACE_DAYS + 2) * DAY),
      },
    });

    const entitlements = await getEntitlements(companyId);
    expect(entitlements.readOnly).toBe(true);
  }, 60_000);

  it("keeps every entry that was already recorded", async () => {
    // The promise the whole file exists to keep. A lapsed subscription is a
    // billing state; it is not a reason to take somebody's accounting away.
    const { companyId } = await createCompany({ openingCashBalance: 25_000 });
    const before = await prisma.journalEntry.count({ where: { companyId } });
    expect(before).toBeGreaterThan(0);

    await prisma.subscription.update({
      where: { companyId },
      data: {
        status: SubscriptionStatus.EXPIRED,
        currentPeriodEnd: new Date(Date.now() - 90 * DAY),
        trialEndsAt: new Date(Date.now() - 90 * DAY),
      },
    });

    const entitlements = await getEntitlements(companyId);
    expect(entitlements.readOnly).toBe(true);
    expect(entitlements.readOnlyReason).toMatch(/still here|stays? readable/i);

    // Nothing was removed, and the reports still read.
    expect(await prisma.journalEntry.count({ where: { companyId } })).toBe(
      before,
    );
    expect(
      await prisma.account.count({ where: { companyId } }),
    ).toBeGreaterThan(0);
  }, 60_000);

  it("still shows the modules, because reading is not writing", async () => {
    const { companyId } = await createCompany();
    await prisma.subscription.update({
      where: { companyId },
      data: {
        status: SubscriptionStatus.CANCELLED,
        currentPeriodEnd: new Date(Date.now() - 30 * DAY),
      },
    });

    const entitlements = await getEntitlements(companyId);
    expect(entitlements.readOnly).toBe(true);
    expect(entitlements.features.has(FEATURE.ACCOUNTING_STATEMENTS)).toBe(true);
  }, 60_000);
});

describe("changing plan", () => {
  it("moves to something cheaper straight away", async () => {
    const { companyId, userId } = await createCompany();
    const result = await changePlan({
      companyId,
      planKey: "starter",
      userId,
      actorEmail: "owner@example.com",
    });

    expect(result.changed).toBe(true);
    const entitlements = await getEntitlements(companyId);
    expect(entitlements.planKey).toBe("starter");
    // Starter does not include analytics, and the gate closes at once.
    expect(entitlements.features.has(FEATURE.ANALYTICS)).toBe(false);
  }, 60_000);

  it("refuses an upgrade rather than granting one nobody paid for", async () => {
    const { companyId, userId } = await createCompany();
    await changePlan({
      companyId,
      planKey: "starter",
      userId,
      actorEmail: "owner@example.com",
    });

    const result = await changePlan({
      companyId,
      planKey: "business",
      userId,
      actorEmail: "owner@example.com",
    });

    expect(result.changed).toBe(false);
    if (result.changed) return;
    expect(result.reason).toMatch(/needs a payment/i);
    expect(result.reason).toMatch(/no payment provider|does not talk to/i);

    // And nothing moved.
    const entitlements = await getEntitlements(companyId);
    expect(entitlements.planKey).toBe("starter");
    expect(entitlements.features.has(FEATURE.AI_AUDITOR)).toBe(false);
  }, 60_000);

  it("does not take a business's records away when the allowance shrinks", async () => {
    // Five users moving to a two-user plan keep working. Adding a sixth is
    // what stops — enforcing a price by locking people out of their own
    // records is not something this does.
    const { companyId, userId } = await createCompany();
    const result = await changePlan({
      companyId,
      planKey: "starter",
      userId,
      actorEmail: "owner@example.com",
    });

    expect(result.changed).toBe(true);
    const memberships = await prisma.membership.count({ where: { companyId } });
    expect(memberships).toBe(1);
  }, 60_000);

  it("writes what happened to the audit log", async () => {
    const { companyId, userId } = await createCompany();
    await changePlan({
      companyId,
      planKey: "starter",
      userId,
      actorEmail: "owner@example.com",
    });

    const entry = await prisma.auditLog.findFirst({
      where: { companyId, action: "billing.plan_changed" },
      orderBy: { createdAt: "desc" },
    });
    expect(entry).toBeTruthy();
  }, 60_000);

  it("says no to a plan that does not exist", async () => {
    const { companyId, userId } = await createCompany();
    const result = await changePlan({
      companyId,
      planKey: "platinum-elite",
      userId,
      actorEmail: "owner@example.com",
    });
    expect(result).toEqual({
      changed: false,
      reason: "That plan is not available.",
    });
  }, 60_000);
});

describe("cancelling", () => {
  it("keeps the period the business has already paid for", async () => {
    const { companyId, userId } = await createCompany();
    await cancelSubscription({
      companyId,
      userId,
      actorEmail: "owner@example.com",
    });

    const overview = await getBillingOverview(companyId);
    expect(overview.cancelAtPeriodEnd).toBe(true);
    // Still able to post until the period runs out.
    expect(overview.entitlements.readOnly).toBe(false);
  }, 60_000);

  it("can be undone before it takes effect", async () => {
    const { companyId, userId } = await createCompany();
    await cancelSubscription({
      companyId,
      userId,
      actorEmail: "owner@example.com",
    });
    const resumed = await resumeSubscription({
      companyId,
      userId,
      actorEmail: "owner@example.com",
    });

    expect(resumed).toBe(true);
    const overview = await getBillingOverview(companyId);
    expect(overview.cancelAtPeriodEnd).toBe(false);
  }, 60_000);
});

describe("the billing page's figures", () => {
  it("says plainly that no payment can be taken here", async () => {
    const { companyId } = await createCompany();
    const overview = await getBillingOverview(companyId);

    expect(overview.payments.available).toBe(false);
    if (overview.payments.available) return;
    expect(overview.payments.reason).toMatch(/payment/i);
  }, 60_000);

  it("shows every allowance with what is actually in use", async () => {
    const { companyId } = await createCompany();
    const overview = await getBillingOverview(companyId);

    const users = overview.lines.find((line) => line.key === "users");
    expect(users?.used).toBe(1);
    expect(users?.limit).toBeGreaterThan(0);
    expect(users?.exhausted).toBe(false);
  }, 60_000);

  it("never reads another business's usage", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);

    await prisma.subscription.update({
      where: { companyId: theirs.companyId },
      data: { limitOverrides: { users: 99 } },
    });

    const [myOverview, theirEntitlements] = await Promise.all([
      getBillingOverview(mine.companyId),
      getEntitlements(theirs.companyId),
    ]);

    expect(theirEntitlements.limits.users).toBe(99);
    expect(myOverview.entitlements.limits.users).not.toBe(99);
  }, 90_000);
});

describe("per-business overrides", () => {
  it("grant a feature the plan does not include", async () => {
    const { companyId } = await createCompany();
    await prisma.subscription.update({
      where: { companyId },
      data: { featureOverrides: { [FEATURE.AI_AUDITOR]: true } },
    });

    const entitlements = await getEntitlements(companyId);
    expect(entitlements.features.has(FEATURE.AI_AUDITOR)).toBe(true);
  }, 60_000);

  it("raise an allowance without touching the plan", async () => {
    const { companyId } = await createCompany();
    await prisma.subscription.update({
      where: { companyId },
      data: { limitOverrides: { users: 25 } },
    });

    const entitlements = await getEntitlements(companyId);
    expect(entitlements.limits.users).toBe(25);
  }, 60_000);
});
