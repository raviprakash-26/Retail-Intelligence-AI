import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises, RULES } from "@/lib/advisor/catalogue";
import type { RegisterInput } from "@/lib/validation/auth";
import type { CustomerInput, ProductInput } from "@/lib/validation/master-data";
import type { SaleInput } from "@/lib/validation/sales";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale } from "@/server/sales/sale-service";
import { resolveFiscalYear } from "@/server/fiscal/fiscal-service";
import { receivablesAgeing } from "@/server/settlements/outstanding";
import { getAdvice } from "@/server/advisor/advisor-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * The advisor, against real books.
 *
 * Three things are being protected. A suggestion has to be true — the amount it
 * quotes must be the amount the page it points at shows. It must not promise
 * anything, which is asserted against the sentences a real run produces rather
 * than only against the catalogue. And it must never see a second business.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

const DAY = 86_400_000;
const TODAY = new Date();
const daysBefore = (days: number): string =>
  new Date(TODAY.getTime() - days * DAY).toISOString().slice(0, 10);

function registrationInput(email: string, name: string): RegisterInput {
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
      businessName: name,
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

type Fixture = {
  companyId: string;
  userId: string;
  actorEmail: string;
  productId: string;
  customerId: string;
};

async function createCompany(): Promise<Fixture> {
  const email = `advice-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(
    registrationInput(email, `Advice ${uniqueSlug("Mart")}`),
  );
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
      openingQuantity: 5_000,
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
      creditLimit: 100_000_000,
      openingBalance: 0,
      openingNature: "DEBIT",
      notes: "",
    } satisfies CustomerInput,
  });

  return { ...base, productId: product.id, customerId: customer.id };
}

async function sellOnCredit(
  fixture: Fixture,
  options: { quantity: number; rate: number; daysAgo: number },
) {
  return createSale({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      customerId: fixture.customerId,
      invoiceDate: daysBefore(options.daysAgo),
      paymentMode: "CREDIT",
      placeOfSupply: "",
      priceIncludesTax: false,
      notes: "",
      lines: [
        {
          productId: fixture.productId,
          description: "",
          quantity: options.quantity,
          rate: options.rate,
          discountPercent: 0,
        },
      ],
    } satisfies SaleInput,
  });
}

async function advise(fixture: Fixture) {
  const year = await resolveFiscalYear(fixture.companyId);
  if (!year) throw new Error("No financial year");
  return getAdvice({
    companyId: fixture.companyId,
    range: "fy",
    fiscalYearStart: year.startDate,
    fiscalYearEnd: year.endDate,
  });
}

beforeAll(async () => {
  await ensurePlatformData();
}, 60_000);

afterAll(async () => {
  for (const companyId of createdCompanies) await purgeTestCompany(companyId);
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
}, 60_000);

describe("what the advisor says about real books", () => {
  it("quotes the same overdue figure the ageing report shows", async () => {
    const fixture = await createCompany();
    // Sold on 30 days' credit, ninety days ago. That invoice is late by any
    // reading, and the amount is not an estimate of anything.
    await sellOnCredit(fixture, { quantity: 400, rate: 100, daysAgo: 90 });

    const [report, ageing] = await Promise.all([
      advise(fixture),
      receivablesAgeing(fixture.companyId),
    ]);

    const overdue = report.suggestions.find(
      (entry) => entry.key === "OVERDUE_RECEIVABLES",
    );
    expect(
      overdue,
      "an invoice 60 days past due went unmentioned",
    ).toBeTruthy();
    if (!overdue || overdue.impact.kind !== "recorded") {
      throw new Error("expected a recorded amount");
    }

    // The whole argument for the page: the figure it quotes is the figure the
    // page it sends you to is showing.
    expect(overdue.impact.amount).toBe(ageing.summary.overdue);
    expect(overdue.evidence.customers).toBe(1);
  }, 60_000);

  it("promises nothing, in the sentences a real run produces", async () => {
    const fixture = await createCompany();
    await sellOnCredit(fixture, { quantity: 400, rate: 100, daysAgo: 90 });

    const report = await advise(fixture);
    expect(report.suggestions.length).toBeGreaterThan(0);

    for (const suggestion of report.suggestions) {
      const rule = RULES[suggestion.key];
      const text = [
        suggestion.observation,
        rule.title,
        rule.whatToDo,
        ...rule.whenThisDoesNotApply,
      ].join(" ");
      expect(promises(text), `${suggestion.key} promises an outcome`).toBe(
        false,
      );
    }
  }, 60_000);

  it("gives every suggestion the reasons to ignore it", async () => {
    const fixture = await createCompany();
    await sellOnCredit(fixture, { quantity: 400, rate: 100, daysAgo: 90 });

    const report = await advise(fixture);
    for (const suggestion of report.suggestions) {
      expect(RULES[suggestion.key].whenThisDoesNotApply.length).toBeGreaterThan(
        1,
      );
      expect(suggestion.observation.length).toBeGreaterThan(20);
    }
  }, 60_000);

  it("says nothing rather than padding the page out", async () => {
    // A shop that has just registered has nothing wrong with it, and three
    // vague ideas so the screen looks busy would be worse than an empty list.
    const fixture = await createCompany();
    const report = await advise(fixture);
    expect(report.suggestions).toHaveLength(0);
    expect(report.empty).toBe(true);
  }, 60_000);

  it("reads the most pressing thing first", async () => {
    const fixture = await createCompany();
    await sellOnCredit(fixture, { quantity: 400, rate: 100, daysAgo: 90 });

    const report = await advise(fixture);
    const urgencies = report.suggestions.map((entry) => entry.urgency);
    const rank = { NOW: 3, SOON: 2, WHEN_YOU_CAN: 1 } as const;
    for (let index = 1; index < urgencies.length; index += 1) {
      const previous = urgencies[index - 1];
      const current = urgencies[index];
      if (!previous || !current) continue;
      expect(rank[previous]).toBeGreaterThanOrEqual(rank[current]);
    }
  }, 60_000);

  /**
   * A line the shop has discontinued.
   *
   * `STOCK_OUT_RISK` already refuses to nag about products nobody stocks any
   * more, and reads intent two ways: a reorder level the owner entered, or
   * recent trade. Neither of those notices that the owner has archived the
   * product outright — which is the plainest statement of intent there is, and
   * the row carries it as a flag.
   *
   * So a discontinued line still holding stock, with a reorder level set
   * before it was retired, was reported as "at or below the reorder level you
   * set". Telling a shop to restock something they have deliberately stopped
   * selling is the small lie this detector was written to avoid.
   */
  it("does not ask the shop to reorder a line it has discontinued", async () => {
    const fixture = await createCompany();
    const { createProduct } =
      await import("@/server/master-data/product-service");
    const { setProductArchived } =
      await import("@/server/master-data/product-service");
    const { getProductTaxonomy } =
      await import("@/server/master-data/taxonomy-service");

    const taxonomy = await getProductTaxonomy(fixture.companyId);
    const unit = taxonomy.units.find((entry) => entry.code === "PCS")!;
    const retired = await createProduct({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        sku: "RETIRED",
        name: "Discontinued line",
        description: "",
        barcode: "",
        hsnCode: "1905",
        categoryId: "",
        unitId: unit.id,
        taxRateId: taxonomy.taxRates[0]!.id,
        purchasePrice: 60,
        sellingPrice: 100,
        mrp: 0,
        isStockTracked: true,
        // Below the level the owner set before retiring it.
        openingQuantity: 2,
        openingRate: 60,
        minStockLevel: 50,
      },
    });

    await setProductArchived({
      companyId: fixture.companyId,
      productId: retired.id,
      archived: true,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
    });

    const advice = await advise(fixture);
    const stockOut = advice.suggestions.find(
      (entry) => entry.key === "STOCK_OUT_RISK",
    );
    expect(stockOut).toBeUndefined();

    // And it is still on the stock report, carrying its value. Silencing the
    // reorder nag must not hide the money: `SLOW_MOVING_STOCK` reads these
    // same rows and a discontinued line is exactly what it is for.
    const { stockRows } = await import("@/server/inventory/inventory-report");
    const rows = await stockRows(fixture.companyId);
    const held = rows.find((row) => row.productId === retired.id);
    expect(held?.archived).toBe(true);
    expect(Number(held?.stockValue)).toBeGreaterThan(0);
  }, 90_000);

  it("never sees a second business", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);

    // Their customer owes a great deal. Mine owes nothing.
    await sellOnCredit(theirs, { quantity: 4_000, rate: 100, daysAgo: 90 });

    const report = await advise(mine);
    expect(
      report.suggestions.some((entry) => entry.key === "OVERDUE_RECEIVABLES"),
    ).toBe(false);

    const rows = await prisma.sale.count({
      where: { companyId: mine.companyId },
    });
    expect(rows).toBe(0);
  }, 90_000);
});
