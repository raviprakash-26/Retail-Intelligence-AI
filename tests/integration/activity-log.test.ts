import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegisterInput } from "@/lib/validation/auth";
import { registerOwner } from "@/server/auth/registration";
import { recordAuditLog } from "@/server/audit/audit-log";
import { ACTIVITY_PAGE, listActivity } from "@/server/audit/audit-log-queries";
import { describeAction } from "@/lib/audit/activity";
import type { Prisma } from "@prisma/client";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Reading the activity log.
 *
 * Thirty-three places write to this table and nothing could read it. What
 * these cases protect is that reading it shows one business its own history —
 * not another's, and not the personal email of a platform administrator who
 * acted on their account.
 */

const createdCompanies: string[] = [];
const createdEmails: string[] = [];

function registrationInput(email: string): RegisterInput {
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
      businessName: `Activity ${uniqueSlug("Mart")}`,
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
      openingCashBalance: 20000,
      openingBankBalance: 0,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

type Fixture = { companyId: string; userId: string; email: string };

async function shop(): Promise<Fixture> {
  const email = `activity-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);
  return { companyId: result.companyId, userId: result.userId, email };
}

async function record(
  fixture: Fixture,
  action: string,
  module = "Settings",
  metadata: Prisma.InputJsonValue = {},
) {
  await recordAuditLog({
    action,
    module,
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.email,
    entityType: "Company",
    entityId: fixture.companyId,
    metadata,
  });
}

beforeAll(async () => {
  await ensurePlatformData();
}, 60_000);

afterAll(async () => {
  for (const companyId of createdCompanies) {
    await purgeTestCompany(companyId).catch(() => undefined);
  }
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

describe("a business reads its own history", () => {
  it("shows what was done, by whom, newest first", async () => {
    const fixture = await shop();
    await record(fixture, "company.data_exported");
    await record(fixture, "fiscalPeriod.closed", "Accounting", {
      period: "August 2026",
    });

    const page = await listActivity({ companyId: fixture.companyId });

    expect(page.entries.length).toBeGreaterThanOrEqual(2);
    expect(page.entries[0]?.action).toBe("fiscalPeriod.closed");
    expect(page.entries[0]?.actor).toBe(fixture.email);
    // The metadata is the part that answers the question somebody came with.
    expect(JSON.stringify(page.entries[0]?.metadata)).toContain("August 2026");
  }, 120_000);

  it("offers the modules it actually has, not a hard-coded list", async () => {
    const fixture = await shop();
    await record(fixture, "company.data_exported", "Settings");
    await record(fixture, "fiscalPeriod.closed", "Accounting");

    const page = await listActivity({ companyId: fixture.companyId });
    expect(page.modules).toContain("Settings");
    expect(page.modules).toContain("Accounting");
  }, 120_000);

  it("filters to one module", async () => {
    const fixture = await shop();
    await record(fixture, "company.data_exported", "Settings");
    await record(fixture, "fiscalPeriod.closed", "Accounting");

    const page = await listActivity({
      companyId: fixture.companyId,
      module: "Accounting",
    });
    expect(page.entries.every((entry) => entry.module === "Accounting")).toBe(
      true,
    );
    expect(
      page.entries.some((entry) => entry.action === "fiscalPeriod.closed"),
    ).toBe(true);
  }, 120_000);
});

describe("one business cannot read another's", () => {
  it("returns nothing of a company it was not asked about", async () => {
    const [mine, theirs] = await Promise.all([shop(), shop()]);
    await record(theirs, "company.data_exported", "Settings", {
      secret: "theirs-only",
    });

    const page = await listActivity({ companyId: mine.companyId });
    const everything = JSON.stringify(page.entries);

    expect(everything).not.toContain("theirs-only");
    expect(everything).not.toContain(theirs.email);
  }, 120_000);

  it("never surfaces an entry belonging to no company", async () => {
    // Some entries are written before a company exists — a registration, a
    // rate limit on a stranger's sign-in attempt. They belong to nobody's
    // activity log and must not fall into one.
    const fixture = await shop();
    await recordAuditLog({
      action: "auth.sign_in_failed",
      module: "Auth",
      companyId: null,
      userId: null,
      actorEmail: "stranger@example.com",
      metadata: { note: "orphan-entry" },
    });

    const page = await listActivity({ companyId: fixture.companyId });
    expect(JSON.stringify(page.entries)).not.toContain("orphan-entry");
    expect(JSON.stringify(page.entries)).not.toContain("stranger@example.com");
  }, 120_000);
});

describe("what a platform administrator did", () => {
  it("is shown, because it was done to this business", async () => {
    // Hiding it would be the product concealing what was done to a customer.
    const fixture = await shop();
    await recordAuditLog({
      action: "admin.plan_updated",
      module: "ADMIN",
      companyId: fixture.companyId,
      userId: null,
      actorEmail: "someone@retailintelligence.local",
      entityType: "Company",
      entityId: fixture.companyId,
      metadata: { plan: "Growth" },
    });

    const page = await listActivity({ companyId: fixture.companyId });
    const entry = page.entries.find(
      (row) => row.action === "admin.plan_updated",
    );
    expect(entry).toBeDefined();
    expect(entry?.byPlatform).toBe(true);
  }, 120_000);

  it("does not hand the customer that administrator's email", async () => {
    // Showing the act is transparency; showing the person is leaking an
    // internal identity to a customer.
    const fixture = await shop();
    await recordAuditLog({
      action: "admin.company_status_changed",
      module: "ADMIN",
      companyId: fixture.companyId,
      userId: null,
      actorEmail: "priya.admin@retailintelligence.local",
      entityType: "Company",
      entityId: fixture.companyId,
      metadata: { status: "ACTIVE" },
    });

    const page = await listActivity({ companyId: fixture.companyId });
    const everything = JSON.stringify(page.entries);

    expect(everything).not.toContain("priya.admin");
    const entry = page.entries.find(
      (row) => row.action === "admin.company_status_changed",
    );
    expect(entry?.actor).toBe("Platform administration");
  }, 120_000);
});

describe("paging", () => {
  it("hands back a cursor and does not repeat an entry across pages", async () => {
    const fixture = await shop();
    for (let index = 0; index < ACTIVITY_PAGE + 5; index += 1) {
      await record(fixture, "company.data_exported", "Settings", { index });
    }

    const first = await listActivity({ companyId: fixture.companyId });
    expect(first.entries).toHaveLength(ACTIVITY_PAGE);
    expect(first.nextCursor).not.toBeNull();

    const second = await listActivity({
      companyId: fixture.companyId,
      cursor: first.nextCursor ?? undefined,
    });

    const firstIds = new Set(first.entries.map((entry) => entry.id));
    expect(second.entries.some((entry) => firstIds.has(entry.id))).toBe(false);
  }, 180_000);

  it("stops offering a cursor at the end", async () => {
    const fixture = await shop();
    await record(fixture, "company.data_exported");

    const page = await listActivity({ companyId: fixture.companyId });
    expect(page.nextCursor).toBeNull();
  }, 120_000);
});

describe("naming an action", () => {
  it("says what the machine name means", () => {
    expect(describeAction("fiscalPeriod.reopened")).toMatch(/reopened/i);
    expect(describeAction("company.data_exported")).toMatch(/complete copy/i);
  });

  it("falls back to the raw name rather than inventing a phrase", () => {
    // A friendly sentence for an action this list has not been taught would be
    // worse than the machine name — it would be a guess presented as a label.
    expect(describeAction("something.nobody.named")).toBe(
      "something.nobody.named",
    );
  });
});
