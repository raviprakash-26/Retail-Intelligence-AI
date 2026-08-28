import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CompanyStatus } from "@prisma/client";
import { findTenantMoney, mentionsAmount } from "@/lib/admin/scope";
import { FEATURE } from "@/lib/billing/plans";
import type { RegisterInput } from "@/lib/validation/auth";
import type { CustomerInput, ProductInput } from "@/lib/validation/master-data";
import type { SaleInput } from "@/lib/validation/sales";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale } from "@/server/sales/sale-service";
import { getEntitlements } from "@/server/billing/entitlement-service";
import {
  getPlatformOverview,
  getTenantDetail,
  listAdminActions,
  listPlans,
  listTenants,
  setCompanyStatus,
  setEntitlementOverride,
  updatePlan,
} from "@/server/admin/admin-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Platform administration.
 *
 * One rule dominates: running the service does not require reading anybody's
 * books. The tests that matter here are not about what the panel shows — they
 * are about what it must never show, and they are run against what the service
 * actually returns for a tenant with a full set of records rather than against
 * a description of what it is supposed to return.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

/** What the platform charges is the platform's revenue, not the tenant's. */
const PLATFORM_OWN_FIGURES = [
  "priceMinor",
  "monthlyRecurringMinor",
  "amountMinor",
];

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
      businessName: `Admin ${uniqueSlug("Mart")}`,
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
      openingCashBalance: 50_000,
      openingBankBalance: 0,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

/** A tenant with real money in its books, so the scope tests have something to find. */
async function createTradingCompany() {
  const email = `admin-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);

  const base = {
    companyId: result.companyId,
    userId: result.userId,
    actorEmail: "owner@example.com",
  };

  const taxonomy = await getProductTaxonomy(result.companyId);
  const unit = taxonomy.units.find((entry) => entry.code === "PCS");
  const rate = taxonomy.taxRates[0];
  if (!unit || !rate) throw new Error("Provisioning is incomplete");

  const product = await createProduct({
    ...base,
    input: {
      sku: "WIDGET",
      name: "Widget",
      description: "",
      barcode: "",
      hsnCode: "1006",
      categoryId: "",
      unitId: unit.id,
      taxRateId: rate.id,
      purchasePrice: 60,
      sellingPrice: 100,
      mrp: 0,
      isStockTracked: true,
      openingQuantity: 1_000,
      openingRate: 60,
      minStockLevel: 0,
    } satisfies ProductInput,
  });

  const customer = await createParty({
    ...base,
    kind: "CUSTOMER",
    input: {
      name: "Sharma Provision Store",
      phone: "",
      email: "",
      gstin: "",
      pan: "",
      addressLine1: "",
      city: "",
      stateCode: "29",
      pincode: "",
      creditDays: 30,
      creditLimit: 10_000_000,
      openingBalance: 0,
      openingNature: "DEBIT",
      notes: "",
    } satisfies CustomerInput,
  });

  await createSale({
    ...base,
    branchId: null,
    input: {
      customerId: customer.id,
      invoiceDate: new Date().toISOString().slice(0, 10),
      paymentMode: "CREDIT",
      placeOfSupply: "",
      priceIncludesTax: false,
      notes: "",
      lines: [
        {
          productId: product.id,
          description: "",
          quantity: 250,
          rate: 137,
          discountPercent: 0,
        },
      ],
    } satisfies SaleInput,
  });

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

describe("what the panel may not show", () => {
  it("lists a trading tenant without a single figure from its books", async () => {
    const { companyId } = await createTradingCompany();
    const list = await listTenants({ page: 1 });

    const row = list.rows.find((entry) => entry.id === companyId);
    expect(row, "the tenant is missing from the list").toBeTruthy();
    // It sold 250 × ₹137 a moment ago, and holds ₹50,000 of opening cash.
    // Neither figure, in any of the shapes money leaves this codebase in, may
    // appear anywhere in what the panel returns.
    const leak = findTenantMoney(list, { allow: PLATFORM_OWN_FIGURES });
    expect(leak, `the tenant list exposes ${leak}`).toBeNull();
    expect(mentionsAmount(list, 34_250)).toBe(false);
    expect(mentionsAmount(list, 50_000)).toBe(false);
  }, 90_000);

  it("shows how much was entered, never what it came to", async () => {
    const { companyId } = await createTradingCompany();
    const list = await listTenants({ page: 1 });
    const row = list.rows.find((entry) => entry.id === companyId);

    // The count is the operational fact support actually needs.
    expect(row?.entriesThisMonth).toBe(1);
    expect(mentionsAmount(row, 34_250)).toBe(false);
  }, 90_000);

  it("opens a tenant without opening its ledger", async () => {
    const { companyId } = await createTradingCompany();
    const detail = await getTenantDetail(companyId);

    expect(detail?.id).toBe(companyId);
    const leak = findTenantMoney(detail, { allow: PLATFORM_OWN_FIGURES });
    expect(leak, `the tenant detail exposes ${leak}`).toBeNull();
    expect(mentionsAmount(detail, 34_250)).toBe(false);
    expect(mentionsAmount(detail, 50_000)).toBe(false);
  }, 90_000);

  /**
   * Every reader the panel has, not the two that were thought of first.
   *
   * `listTenants` and `getTenantDetail` were swept for tenant money; the other
   * three were exercised for what they return and never checked for what they
   * must not. The boundary in `lib/admin/scope.ts` is stated about the panel,
   * not about two of its five functions — and the platform dashboard is
   * precisely where somebody would add a total-value-across-tenants figure as
   * a business metric, which is the disclosure that file exists to refuse.
   *
   * The companion case below holds this list against the module's exports, so
   * a sixth reader cannot be added and left out of it.
   */
  it("shows no tenant money from any of its readers", async () => {
    const { companyId } = await createTradingCompany();

    const returns: Array<[string, unknown]> = [
      ["getPlatformOverview", await getPlatformOverview()],
      ["listTenants", await listTenants({ page: 1 })],
      ["getTenantDetail", await getTenantDetail(companyId)],
      ["listPlans", await listPlans()],
      ["listAdminActions", await listAdminActions(20)],
    ];

    for (const [name, value] of returns) {
      const leak = findTenantMoney(value, { allow: PLATFORM_OWN_FIGURES });
      expect(leak, `${name} exposes ${leak}`).toBeNull();
      // The figures this tenant actually holds, in every shape money leaves
      // this codebase in. A name-based rule cannot catch a field somebody
      // called `thisMonth`.
      expect(mentionsAmount(value, 34_250), `${name} names the sale`).toBe(
        false,
      );
      expect(mentionsAmount(value, 50_000), `${name} names the cash`).toBe(
        false,
      );
    }
  }, 120_000);

  it("keeps that list level with what the module exports", async () => {
    // The half that makes the case above stay true. A reader added to the
    // admin service and not to the sweep is exactly how the first three came
    // to be unswept.
    const source = readFileSync("src/server/admin/admin-service.ts", "utf8");
    const exported = [
      ...source.matchAll(/^export async function ([A-Za-z0-9_]+)/gm),
    ].map((match) => match[1]!);

    // Readers only. The three writers are what an administrator *does*, and
    // they are guarded by the permission gate and the audit log rather than by
    // this boundary.
    const writers = [
      "setCompanyStatus",
      "setEntitlementOverride",
      "updatePlan",
    ];
    const readers = exported.filter((name) => !writers.includes(name));

    expect(readers.sort()).toEqual(
      [
        "getPlatformOverview",
        "getTenantDetail",
        "listAdminActions",
        "listPlans",
        "listTenants",
      ].sort(),
    );
  });

  it("does not name the businesses a tenant trades with", async () => {
    // Who a shop's customers are is worth as much as what it sold them.
    const { companyId } = await createTradingCompany();
    const detail = await getTenantDetail(companyId);
    expect(JSON.stringify(detail)).not.toContain("Sharma Provision Store");
  }, 90_000);

  it("shows who can sign in, because support needs that", async () => {
    const { companyId } = await createTradingCompany();
    const detail = await getTenantDetail(companyId);
    expect(detail?.members.length).toBeGreaterThan(0);
    expect(detail?.members[0]?.roleName).toBeTruthy();
  }, 90_000);
});

describe("the platform's own figures", () => {
  it("counts tenants, signups and subscriptions", async () => {
    await createTradingCompany();
    const overview = await getPlatformOverview();

    expect(overview.tenants.total).toBeGreaterThan(0);
    expect(overview.signups.thisMonth).toBeGreaterThan(0);
    expect(overview.subscriptions.trialing).toBeGreaterThan(0);
  }, 90_000);

  it("does not count a trial as revenue", async () => {
    // A dashboard that counts trials as money is the first step to believing
    // it. Everything created by these tests is trialing.
    const overview = await getPlatformOverview();
    const trialingOnly = overview.subscriptions.active === 0;
    if (trialingOnly) expect(overview.monthlyRecurringMinor).toBe(0);
  }, 60_000);

  it("carries no tenant money either", async () => {
    await createTradingCompany();
    const overview = await getPlatformOverview();
    const leak = findTenantMoney(overview, { allow: PLATFORM_OWN_FIGURES });
    expect(leak, `the overview exposes ${leak}`).toBeNull();
  }, 90_000);
});

describe("what an administrator may change", () => {
  it("suspends an account without deleting anything", async () => {
    const { companyId, userId } = await createTradingCompany();
    const before = await prisma.journalEntry.count({ where: { companyId } });

    const done = await setCompanyStatus({
      companyId,
      status: CompanyStatus.SUSPENDED,
      adminId: userId,
      adminEmail: "admin@example.com",
      reason: "Testing",
    });

    expect(done).toBe(true);
    expect(await prisma.journalEntry.count({ where: { companyId } })).toBe(
      before,
    );

    // And is reversible by whoever disagrees.
    await setCompanyStatus({
      companyId,
      status: CompanyStatus.ACTIVE,
      adminId: userId,
      adminEmail: "admin@example.com",
    });
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { status: true },
    });
    expect(company?.status).toBe(CompanyStatus.ACTIVE);
  }, 90_000);

  it("grants one business a feature its plan does not include", async () => {
    const { companyId, userId } = await createTradingCompany();
    expect(
      (await getEntitlements(companyId)).features.has(FEATURE.AI_AUDITOR),
    ).toBe(false);

    await setEntitlementOverride({
      companyId,
      featureOverrides: { [FEATURE.AI_AUDITOR]: true },
      adminId: userId,
      adminEmail: "admin@example.com",
    });

    expect(
      (await getEntitlements(companyId)).features.has(FEATURE.AI_AUDITOR),
    ).toBe(true);
  }, 90_000);

  it("changes what a plan includes for everybody on it", async () => {
    const { companyId, userId } = await createTradingCompany();
    const plans = await listPlans();
    const professional = plans.find((plan) => plan.key === "professional");
    if (!professional) throw new Error("The professional plan is missing");

    const before = await getEntitlements(companyId);
    expect(before.features.has(FEATURE.AI_ADVISOR)).toBe(false);

    await updatePlan({
      planId: professional.id,
      features: [...professional.features, FEATURE.AI_ADVISOR],
      adminId: userId,
      adminEmail: "admin@example.com",
    });

    const after = await getEntitlements(companyId);
    expect(after.features.has(FEATURE.AI_ADVISOR)).toBe(true);

    // Put it back, because every other test in this file reads these rows.
    await updatePlan({
      planId: professional.id,
      features: professional.features,
      adminId: userId,
      adminEmail: "admin@example.com",
    });
  }, 90_000);

  it("writes every change to the audit log with who did it", async () => {
    // Administration that leaves no trace is indistinguishable from a breach
    // afterwards.
    const { companyId, userId } = await createTradingCompany();
    await setCompanyStatus({
      companyId,
      status: CompanyStatus.SUSPENDED,
      adminId: userId,
      adminEmail: "someone@example.com",
    });

    const actions = await listAdminActions(20);
    const entry = actions.find(
      (row) => row.entityId === companyId && row.action.startsWith("admin."),
    );
    expect(entry).toBeTruthy();
    expect(entry?.actorEmail).toBe("someone@example.com");
  }, 90_000);
});

describe("the search", () => {
  it("finds a tenant by name without widening to everything", async () => {
    const { companyId } = await createTradingCompany();
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true },
    });
    if (!company) throw new Error("missing");

    const found = await listTenants({ query: company.name });
    expect(found.rows.some((row) => row.id === companyId)).toBe(true);

    const nothing = await listTenants({ query: "zzz-no-such-business-zzz" });
    expect(nothing.rows).toHaveLength(0);
    expect(nothing.total).toBe(0);
  }, 90_000);
});
