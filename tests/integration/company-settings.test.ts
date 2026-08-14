import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VoucherType } from "@prisma/client";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import type { RegisterInput } from "@/lib/validation/auth";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import { registerOwner } from "@/server/auth/registration";
import {
  createBranch,
  listBranches,
  setBranchActive,
  setPrimaryBranch,
  updateBranch,
} from "@/server/company/branch-service";
import { getOnboardingChecklist } from "@/server/company/onboarding-service";
import {
  describeAccountingLocks,
  isLocked,
  updateCompanyAccounting,
  updateCompanyProfile,
} from "@/server/company/settings-service";
import { ALL_PERMISSION_KEYS } from "@/lib/rbac/permissions";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

const prisma = testDb();
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
      businessName: "Settings Test Mart",
      businessType: "SOLE_PROPRIETORSHIP",
      gstRegistration: "UNREGISTERED",
      gstin: "",
      pan: "",
      addressLine1: "42 Avenue Road",
      city: "Bengaluru",
      stateCode: "29",
      pincode: "560053",
    },
    accounting: {
      fiscalYearStartMonth: 4,
      currency: "INR",
      openingCashBalance: 0,
      openingBankBalance: 0,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

async function createCompany() {
  const email = `settings-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);
  return { ...result, email };
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

describe("accounting setting locks", () => {
  it("leaves everything unlocked before anything is posted", async () => {
    const company = await createCompany();
    const locks = await describeAccountingLocks(company.companyId);

    expect(locks.postedEntryCount).toBe(0);
    expect(locks.stockMovementCount).toBe(0);
    expect(isLocked(locks, "fiscalYearStartMonth")).toBe(false);
    expect(isLocked(locks, "currency")).toBe(false);
    expect(isLocked(locks, "inventoryMethod")).toBe(false);
  }, 60_000);

  it("allows changing the fiscal year while the books are empty", async () => {
    const company = await createCompany();

    await updateCompanyAccounting({
      companyId: company.companyId,
      userId: company.userId,
      actorEmail: company.email,
      input: {
        fiscalYearStartMonth: 1,
        currency: "USD",
        inventoryMethod: "FIFO",
        timezone: "UTC",
      },
    });

    const updated = await prisma.company.findUniqueOrThrow({
      where: { id: company.companyId },
      select: {
        fiscalYearStartMonth: true,
        currency: true,
        inventoryMethod: true,
        timezone: true,
      },
    });

    expect(updated.fiscalYearStartMonth).toBe(1);
    expect(updated.currency).toBe("USD");
    expect(updated.inventoryMethod).toBe("FIFO");
    expect(updated.timezone).toBe("UTC");
  }, 60_000);

  it("locks the fiscal year and currency once an entry is posted", async () => {
    const company = await createCompany();

    const accounts = await prisma.account.findMany({
      where: {
        companyId: company.companyId,
        systemKey: { in: [SYSTEM_ACCOUNT.CASH, SYSTEM_ACCOUNT.SALES] },
      },
      select: { id: true, systemKey: true },
    });
    const byKey = new Map(accounts.map((a) => [a.systemKey, a.id]));

    await postJournalEntry(prisma, {
      companyId: company.companyId,
      entryDate: new Date(Date.UTC(new Date().getUTCFullYear(), 5, 15)),
      voucherType: VoucherType.JOURNAL,
      lines: [
        { accountId: byKey.get(SYSTEM_ACCOUNT.CASH)!, debit: 1000 },
        { accountId: byKey.get(SYSTEM_ACCOUNT.SALES)!, credit: 1000 },
      ],
    });

    const locks = await describeAccountingLocks(company.companyId);
    expect(locks.postedEntryCount).toBe(1);
    expect(isLocked(locks, "fiscalYearStartMonth")).toBe(true);
    expect(isLocked(locks, "currency")).toBe(true);
    // Stock has not moved, so valuation is still open.
    expect(isLocked(locks, "inventoryMethod")).toBe(false);

    // Each lock explains itself; a disabled field with no reason is a support
    // ticket waiting to happen.
    for (const lock of locks.locks.filter((entry) => entry.locked)) {
      expect(lock.reason).toBeTruthy();
    }
  }, 60_000);

  it("ignores a locked field instead of applying or rejecting it", async () => {
    const company = await createCompany();

    const accounts = await prisma.account.findMany({
      where: {
        companyId: company.companyId,
        systemKey: { in: [SYSTEM_ACCOUNT.CASH, SYSTEM_ACCOUNT.SALES] },
      },
      select: { id: true, systemKey: true },
    });
    const byKey = new Map(accounts.map((a) => [a.systemKey, a.id]));

    await postJournalEntry(prisma, {
      companyId: company.companyId,
      entryDate: new Date(Date.UTC(new Date().getUTCFullYear(), 5, 15)),
      voucherType: VoucherType.JOURNAL,
      lines: [
        { accountId: byKey.get(SYSTEM_ACCOUNT.CASH)!, debit: 500 },
        { accountId: byKey.get(SYSTEM_ACCOUNT.SALES)!, credit: 500 },
      ],
    });

    const result = await updateCompanyAccounting({
      companyId: company.companyId,
      userId: company.userId,
      actorEmail: company.email,
      input: {
        fiscalYearStartMonth: 7,
        currency: "USD",
        inventoryMethod: "FIFO",
        // The one field that is always editable.
        timezone: "Asia/Dubai",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ignoredFields).toContain("fiscalYearStartMonth");
      expect(result.ignoredFields).toContain("currency");
    }

    const after = await prisma.company.findUniqueOrThrow({
      where: { id: company.companyId },
      select: {
        fiscalYearStartMonth: true,
        currency: true,
        inventoryMethod: true,
        timezone: true,
      },
    });

    // Locked fields kept their value; the editable one went through.
    expect(after.fiscalYearStartMonth).toBe(4);
    expect(after.currency).toBe("INR");
    expect(after.inventoryMethod).toBe("FIFO");
    expect(after.timezone).toBe("Asia/Dubai");
  }, 60_000);
});

describe("business profile", () => {
  it("saves changes and logs a GST change separately", async () => {
    const company = await createCompany();

    await updateCompanyProfile({
      companyId: company.companyId,
      userId: company.userId,
      actorEmail: company.email,
      input: {
        name: "Renamed Retail Mart",
        legalName: "",
        businessType: "PRIVATE_LIMITED",
        gstRegistration: "REGULAR",
        gstin: "29AAAPR1234K1ZP",
        pan: "AAAPR1234K",
        addressLine1: "New Address 1",
        addressLine2: "",
        city: "Mysuru",
        stateCode: "29",
        pincode: "570001",
        phone: "9845000000",
        email: "hello@example.com",
        website: "",
      },
    });

    const updated = await prisma.company.findUniqueOrThrow({
      where: { id: company.companyId },
      select: { name: true, gstin: true, state: true, gstRegistration: true },
    });

    expect(updated.name).toBe("Renamed Retail Mart");
    expect(updated.gstin).toBe("29AAAPR1234K1ZP");
    // The state name is derived from the code, not trusted from the client.
    expect(updated.state).toBe("Karnataka");

    // Moving from unregistered to regular changes how every future invoice is
    // taxed, so it gets its own audit event rather than being buried.
    const gstLog = await prisma.auditLog.findFirst({
      where: {
        companyId: company.companyId,
        action: "company.gst_registration_changed",
      },
      select: { metadata: true },
    });
    expect(gstLog).not.toBeNull();
  }, 60_000);
});

describe("branches", () => {
  it("starts with one primary branch from provisioning", async () => {
    const company = await createCompany();
    const branches = await listBranches(company.companyId);

    expect(branches).toHaveLength(1);
    expect(branches[0]?.isPrimary).toBe(true);
    expect(branches[0]?.code).toBe("MAIN");
  }, 60_000);

  it("refuses a duplicate branch code within the company", async () => {
    const company = await createCompany();

    await expect(
      createBranch({
        companyId: company.companyId,
        userId: company.userId,
        actorEmail: company.email,
        input: {
          code: "MAIN",
          name: "Duplicate",
          addressLine1: "",
          city: "",
          stateCode: "",
          pincode: "",
          phone: "",
        },
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_CODE" });
  }, 60_000);

  it("lets two companies use the same branch code", async () => {
    const [first, second] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);

    for (const company of [first, second]) {
      await createBranch({
        companyId: company.companyId,
        userId: company.userId,
        actorEmail: company.email,
        input: {
          code: "BLR2",
          name: "Jayanagar",
          addressLine1: "",
          city: "Bengaluru",
          stateCode: "29",
          pincode: "",
          phone: "",
        },
      });
    }

    expect(
      await prisma.branch.count({ where: { code: "BLR2" } }),
    ).toBeGreaterThanOrEqual(2);
  }, 90_000);

  it("refuses to close the primary branch", async () => {
    const company = await createCompany();
    const branches = await listBranches(company.companyId);

    await expect(
      setBranchActive({
        companyId: company.companyId,
        branchId: branches[0]!.id,
        isActive: false,
        userId: company.userId,
        actorEmail: company.email,
      }),
    ).rejects.toMatchObject({ code: "PRIMARY_BRANCH" });
  }, 60_000);

  it("moves primary status without ever having two", async () => {
    const company = await createCompany();
    const second = await createBranch({
      companyId: company.companyId,
      userId: company.userId,
      actorEmail: company.email,
      input: {
        code: "BLR3",
        name: "Malleshwaram",
        addressLine1: "",
        city: "Bengaluru",
        stateCode: "29",
        pincode: "",
        phone: "",
      },
    });

    await setPrimaryBranch({
      companyId: company.companyId,
      branchId: second.id,
      userId: company.userId,
      actorEmail: company.email,
    });

    const branches = await listBranches(company.companyId);
    const primaries = branches.filter((branch) => branch.isPrimary);
    // A partial unique index allows exactly one; the swap must be atomic.
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.id).toBe(second.id);
  }, 60_000);

  it("refuses to edit a branch belonging to another company", async () => {
    const [first, second] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);
    const otherBranches = await listBranches(second.companyId);

    await expect(
      updateBranch({
        companyId: first.companyId,
        branchId: otherBranches[0]!.id,
        userId: first.userId,
        actorEmail: first.email,
        input: {
          code: "HACK",
          name: "Hijacked",
          addressLine1: "",
          city: "",
          stateCode: "",
          pincode: "",
          phone: "",
        },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 90_000);
});

describe("onboarding checklist", () => {
  it("reflects a freshly registered company", async () => {
    const company = await createCompany();

    const checklist = await getOnboardingChecklist({
      companyId: company.companyId,
      emailVerified: false,
      permissions: new Set(ALL_PERMISSION_KEYS),
    });

    expect(checklist.allRequiredDone).toBe(false);
    expect(checklist.percent).toBeLessThan(100);

    const byKey = new Map(checklist.items.map((item) => [item.key, item]));
    expect(byKey.get("verify-email")?.done).toBe(false);
    expect(byKey.get("products")?.done).toBe(false);
    expect(byKey.get("first-sale")?.done).toBe(false);
    // Registered as UNREGISTERED, so the GST step is already satisfied.
    expect(byKey.get("gst-setup")?.done).toBe(true);
  }, 60_000);

  it("hides steps the viewer has no permission to act on", async () => {
    const company = await createCompany();

    const checklist = await getOnboardingChecklist({
      companyId: company.companyId,
      emailVerified: true,
      // A cashier-shaped permission set.
      permissions: new Set(["dashboard.view", "sales.create"] as never),
    });

    const keys = checklist.items.map((item) => item.key);
    expect(keys).toContain("verify-email");
    expect(keys).toContain("first-sale");
    // No settings or product permissions, so those steps are not shown.
    expect(keys).not.toContain("business-details");
    expect(keys).not.toContain("products");
  }, 60_000);

  it("counts only required items towards completion", async () => {
    const company = await createCompany();

    const checklist = await getOnboardingChecklist({
      companyId: company.companyId,
      emailVerified: true,
      permissions: new Set(ALL_PERMISSION_KEYS),
    });

    const optional = checklist.items.filter((item) => item.optional);
    expect(optional.length).toBeGreaterThan(0);
    expect(checklist.total).toBe(
      checklist.items.filter((item) => !item.optional).length,
    );
  }, 60_000);
});
