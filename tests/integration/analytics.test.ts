import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toStorageString } from "@/lib/money";
import type { RegisterInput } from "@/lib/validation/auth";
import type { CustomerInput, ProductInput } from "@/lib/validation/master-data";
import type { SaleInput } from "@/lib/validation/sales";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale } from "@/server/sales/sale-service";
import { createSalesReturn } from "@/server/returns/sales-return-service";
import { createPurchase } from "@/server/purchases/purchase-service";
import { createPurchaseReturn } from "@/server/returns/purchase-return-service";
import type { PurchaseInput } from "@/lib/validation/purchases";
import { getFinancialStatements } from "@/server/accounting/statements-service";
import {
  getAnalytics,
  resolveRange,
} from "@/server/analytics/analytics-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Analytics.
 *
 * The property that matters most is that the page cannot disagree with the
 * statements: the trend buckets have to add up to the revenue on the profit and
 * loss account, because both are read from the same posted lines. The rest is
 * that nothing is invented — no growth percentage against a period with no
 * sales, no ratio where the denominator is nil, and nothing at all across a
 * tenant boundary.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

/** Inside the fiscal year registration opens for a business today. */
const EARLY = "2026-05-04"; // a Monday
const MID = "2026-06-16";
const LATE = "2026-07-21";

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
      businessName: `Analytics ${uniqueSlug("Mart")}`,
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
      openingCashBalance: 200000,
      openingBankBalance: 200000,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

type Fixture = {
  companyId: string;
  userId: string;
  actorEmail: string;
  fiscalYearStart: Date;
  fiscalYearEnd: Date;
  riceId: string;
  soapId: string;
  bigCustomerId: string;
  smallCustomerId: string;
  thirdCustomerId: string;
};

async function createCompany(): Promise<Fixture> {
  const email = `anly-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);

  const base = {
    companyId: result.companyId,
    userId: result.userId,
    actorEmail: "owner@example.com",
  };

  const year = await prisma.fiscalYear.findFirstOrThrow({
    where: { companyId: result.companyId },
    select: { startDate: true, endDate: true },
  });

  const taxonomy = await getProductTaxonomy(result.companyId);
  const unit = taxonomy.units.find((entry) => entry.code === "PCS");
  const gst18 = taxonomy.taxRates.find((entry) => entry.code === "GST18");
  if (!unit || !gst18) throw new Error("Provisioning is incomplete");

  const product = (
    sku: string,
    name: string,
    cost: number,
    price: number,
  ): ProductInput => ({
    sku,
    name,
    description: "",
    barcode: "",
    hsnCode: "1006",
    categoryId: "",
    unitId: unit.id,
    taxRateId: gst18.id,
    purchasePrice: cost,
    sellingPrice: price,
    mrp: 0,
    isStockTracked: true,
    openingQuantity: 10_000,
    openingRate: cost,
    minStockLevel: 0,
  });

  // Rice sells in volume on a thin margin; soap sells less on a fat one. The
  // biggest seller and the biggest earner are deliberately different products.
  const rice = await createProduct({
    ...base,
    input: product("RICE", "Rice", 90, 100),
  });
  const soap = await createProduct({
    ...base,
    input: product("SOAP", "Soap", 10, 40),
  });

  const customerBase = {
    phone: "",
    email: "",
    pan: "",
    addressLine1: "",
    city: "",
    stateCode: "29",
    pincode: "",
    creditDays: 30,
    creditLimit: 10_000_000,
    openingBalance: 0,
    openingNature: "DEBIT" as const,
    notes: "",
  };

  const big = await createParty({
    ...base,
    kind: "CUSTOMER",
    input: {
      ...customerBase,
      name: "Sharma Provision Store",
      gstin: "29AABCS1429B1ZX",
    } satisfies CustomerInput,
  });
  const small = await createParty({
    ...base,
    kind: "CUSTOMER",
    input: { ...customerBase, name: "Lakshmi Kirana", gstin: "" },
  });
  const third = await createParty({
    ...base,
    kind: "CUSTOMER",
    input: { ...customerBase, name: "Anand Stores", gstin: "" },
  });

  return {
    ...base,
    fiscalYearStart: year.startDate,
    fiscalYearEnd: year.endDate,
    riceId: rice.id,
    soapId: soap.id,
    bigCustomerId: big.id,
    smallCustomerId: small.id,
    thirdCustomerId: third.id,
  };
}

async function sell(
  fixture: Fixture,
  options: {
    productId: string;
    quantity: number;
    rate: number;
    date: string;
    customerId?: string;
  },
) {
  return createSale({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      customerId: options.customerId ?? fixture.bigCustomerId,
      invoiceDate: options.date,
      paymentMode: "BANK",
      placeOfSupply: "",
      priceIncludesTax: false,
      notes: "",
      lines: [
        {
          productId: options.productId,
          description: "",
          quantity: options.quantity,
          rate: options.rate,
          discountPercent: 0,
        },
      ],
    } satisfies SaleInput,
  });
}

/** Reported on the whole fiscal year, as the page does by default. */
const analyticsFor = (
  fixture: Fixture,
  today = new Date("2026-08-15T00:00:00.000Z"),
) =>
  getAnalytics({
    companyId: fixture.companyId,
    range: "fy",
    fiscalYearStart: fixture.fiscalYearStart,
    fiscalYearEnd: fixture.fiscalYearEnd,
    today,
  });

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

describe("the trend cannot disagree with the statements", () => {
  it("adds its buckets up to the revenue on the profit and loss account", async () => {
    const fixture = await createCompany();
    await sell(fixture, {
      productId: fixture.riceId,
      quantity: 100,
      rate: 100,
      date: EARLY,
    });
    await sell(fixture, {
      productId: fixture.soapId,
      quantity: 50,
      rate: 40,
      date: MID,
    });
    await sell(fixture, {
      productId: fixture.riceId,
      quantity: 30,
      rate: 100,
      date: LATE,
    });

    const report = await analyticsFor(fixture);
    const statements = await getFinancialStatements({
      companyId: fixture.companyId,
      from: report.from,
      to: report.to,
    });

    const bucketed = report.trend.reduce(
      (sum, point) => sum + Number(point.revenue),
      0,
    );
    expect(bucketed).toBeCloseTo(Number(statements.trading.revenueTotal), 2);
    expect(report.revenue.current).toBe(statements.trading.revenueTotal);

    const cost = report.trend.reduce(
      (sum, point) => sum + Number(point.costOfSales),
      0,
    );
    expect(cost).toBeCloseTo(Number(statements.trading.costOfSalesTotal), 2);
  });

  it("splits gross profit as revenue less cost of sales, bucket by bucket", async () => {
    const fixture = await createCompany();
    await sell(fixture, {
      productId: fixture.riceId,
      quantity: 100,
      rate: 100,
      date: EARLY,
    });

    const report = await analyticsFor(fixture);
    for (const point of report.trend) {
      expect(Number(point.grossProfit)).toBeCloseTo(
        Number(point.revenue) - Number(point.costOfSales),
        2,
      );
    }
  });

  it("counts the bills in each bucket", async () => {
    const fixture = await createCompany();
    await sell(fixture, {
      productId: fixture.riceId,
      quantity: 10,
      rate: 100,
      date: MID,
    });
    await sell(fixture, {
      productId: fixture.soapId,
      quantity: 10,
      rate: 40,
      date: MID,
    });

    const report = await analyticsFor(fixture);
    const bills = report.trend.reduce((sum, point) => sum + point.bills, 0);
    expect(bills).toBe(2);
    expect(report.bills.current).toBe(2);
  });
});

describe("comparison with the period before", () => {
  it("refuses a percentage when the previous period had nothing", async () => {
    // Growth "from ₹0" is a division nobody should be shown.
    const fixture = await createCompany();
    await sell(fixture, {
      productId: fixture.riceId,
      quantity: 100,
      rate: 100,
      date: MID,
    });

    const report = await analyticsFor(fixture);
    expect(Number(report.revenue.current)).toBeGreaterThan(0);
    expect(report.revenue.previous).toBe(toStorageString(0));
    expect(report.revenue.changePercent).toBeNull();
    // The absolute change is still meaningful and is still given.
    expect(report.revenue.change).toBe(report.revenue.current);
  });

  it("compares against the same length of time immediately before", async () => {
    const fixture = await createCompany();
    const report = await analyticsFor(fixture);

    const days = (from: string, to: string) =>
      Math.round(
        (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000,
      ) + 1;

    expect(days(report.previousFrom, report.previousTo)).toBe(
      days(report.from, report.to),
    );
    expect(new Date(report.previousTo).getTime()).toBeLessThan(
      new Date(report.from).getTime(),
    );
  });

  it("reports the running year up to today rather than to a future year end", async () => {
    // Otherwise every average is flattened by months that have not happened.
    const fixture = await createCompany();
    const today = new Date("2026-08-15T00:00:00.000Z");
    const report = await analyticsFor(fixture, today);

    expect(report.to).toBe("2026-08-15");
    expect(new Date(report.to).getTime()).toBeLessThan(
      fixture.fiscalYearEnd.getTime(),
    );
  });
});

describe("resolving a window", () => {
  const fy = {
    fiscalYearStart: new Date(Date.UTC(2026, 3, 1)),
    fiscalYearEnd: new Date(Date.UTC(2027, 2, 31)),
    today: new Date(Date.UTC(2026, 7, 15)),
  };

  it("gives the last thirty days, ending today", () => {
    const range = resolveRange({ range: "30d", ...fy });
    expect(range.to.toISOString().slice(0, 10)).toBe("2026-08-15");
    expect(range.from.toISOString().slice(0, 10)).toBe("2026-07-17");
  });

  it("puts the comparison window immediately before, at the same length", () => {
    const range = resolveRange({ range: "90d", ...fy });
    const length = (from: Date, to: Date) =>
      Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;

    expect(length(range.from, range.to)).toBe(90);
    expect(length(range.previousFrom, range.previousTo)).toBe(90);
    expect(range.previousTo.getTime()).toBe(range.from.getTime() - 86_400_000);
  });

  it("uses the whole year once it has finished", () => {
    const range = resolveRange({
      range: "fy",
      fiscalYearStart: new Date(Date.UTC(2025, 3, 1)),
      fiscalYearEnd: new Date(Date.UTC(2026, 2, 31)),
      today: new Date(Date.UTC(2026, 7, 15)),
    });
    expect(range.to.toISOString().slice(0, 10)).toBe("2026-03-31");
  });
});

describe("products", () => {
  it("separates the biggest seller from the biggest earner", async () => {
    const fixture = await createCompany();
    // Rice: 100 × ₹100 = ₹10,000 revenue, ₹9,000 cost, ₹1,000 profit.
    // Soap: 200 × ₹40  = ₹8,000 revenue, ₹2,000 cost, ₹6,000 profit.
    await sell(fixture, {
      productId: fixture.riceId,
      quantity: 100,
      rate: 100,
      date: MID,
    });
    await sell(fixture, {
      productId: fixture.soapId,
      quantity: 200,
      rate: 40,
      date: MID,
    });

    const report = await analyticsFor(fixture);
    const rice = report.products.find((entry) => entry.sku === "RICE");
    const soap = report.products.find((entry) => entry.sku === "SOAP");

    expect(rice?.revenue).toBe(toStorageString(10_000));
    expect(rice?.cost).toBe(toStorageString(9_000));
    expect(rice?.grossProfit).toBe(toStorageString(1_000));
    expect(rice?.marginPercent).toBeCloseTo(10, 1);

    expect(soap?.grossProfit).toBe(toStorageString(6_000));
    expect(soap?.marginPercent).toBeCloseTo(75, 1);

    // Sorted by revenue, so rice leads — while soap earns six times as much.
    expect(report.products[0]?.sku).toBe("RICE");
    expect(Number(soap?.grossProfit)).toBeGreaterThan(
      Number(rice?.grossProfit),
    );
  });

  it("uses the cost captured when the sale posted, not today's price", async () => {
    const fixture = await createCompany();
    await sell(fixture, {
      productId: fixture.soapId,
      quantity: 10,
      rate: 40,
      date: MID,
    });

    // Move the purchase price after the fact. The margin already recorded must
    // not move with it, or last month's figures change every month.
    await prisma.product.update({
      where: { id: fixture.soapId },
      data: { purchasePrice: "35" },
    });

    const report = await analyticsFor(fixture);
    const soap = report.products.find((entry) => entry.sku === "SOAP");
    expect(soap?.cost).toBe(toStorageString(100));
  });

  it("adds every product's share to a hundred", async () => {
    const fixture = await createCompany();
    await sell(fixture, {
      productId: fixture.riceId,
      quantity: 50,
      rate: 100,
      date: MID,
    });
    await sell(fixture, {
      productId: fixture.soapId,
      quantity: 50,
      rate: 40,
      date: LATE,
    });

    const report = await analyticsFor(fixture);
    const share = report.products.reduce(
      (sum, entry) => sum + entry.sharePercent,
      0,
    );
    expect(share).toBeCloseTo(100, 0);
  });
});

describe("customers", () => {
  it("ranks them and states concentration as a fact", async () => {
    const fixture = await createCompany();
    await sell(fixture, {
      productId: fixture.riceId,
      quantity: 100,
      rate: 100,
      date: MID,
      customerId: fixture.bigCustomerId,
    });
    await sell(fixture, {
      productId: fixture.soapId,
      quantity: 10,
      rate: 40,
      date: MID,
      customerId: fixture.smallCustomerId,
    });
    await sell(fixture, {
      productId: fixture.soapId,
      quantity: 5,
      rate: 40,
      date: MID,
      customerId: fixture.thirdCustomerId,
    });

    const report = await analyticsFor(fixture);
    expect(report.customers[0]?.name).toBe("Sharma Provision Store");
    expect(report.concentration.topSharePercent).toBeGreaterThan(90);
    expect(report.concentration.note).toMatch(/accounts for/);
    // Worded as an observation about the period, not as a warning.
    expect(report.concentration.note).not.toMatch(/risk|should|must/i);
  });

  it("says nothing about concentration when it is spread", async () => {
    const fixture = await createCompany();
    for (const customerId of [
      fixture.bigCustomerId,
      fixture.smallCustomerId,
      fixture.thirdCustomerId,
    ]) {
      await sell(fixture, {
        productId: fixture.riceId,
        quantity: 50,
        rate: 100,
        date: MID,
        customerId,
      });
    }

    const report = await analyticsFor(fixture);
    expect(report.customers).toHaveLength(3);
    expect(report.concentration.topSharePercent).toBeCloseTo(33.3, 0);
    expect(report.concentration.note).toBeNull();
  });

  it("stays quiet where there are too few names for a share to mean anything", async () => {
    // Two customers split evenly is 50% each. That is arithmetic, not
    // concentration, and remarking on it would be noise.
    const fixture = await createCompany();
    await sell(fixture, {
      productId: fixture.riceId,
      quantity: 50,
      rate: 100,
      date: MID,
      customerId: fixture.bigCustomerId,
    });
    await sell(fixture, {
      productId: fixture.riceId,
      quantity: 50,
      rate: 100,
      date: MID,
      customerId: fixture.smallCustomerId,
    });

    const report = await analyticsFor(fixture);
    expect(report.concentration.topSharePercent).toBeCloseTo(50, 0);
    expect(report.concentration.note).toBeNull();
  });
});

describe("the shape of the week", () => {
  it("returns every day, including the ones with nothing on them", async () => {
    // A missing Tuesday reads as a formatting quirk; an empty Tuesday reads as
    // a fact about the business.
    const fixture = await createCompany();
    await sell(fixture, {
      productId: fixture.riceId,
      quantity: 10,
      rate: 100,
      date: EARLY,
    });

    const report = await analyticsFor(fixture);
    expect(report.weekdays).toHaveLength(7);
    expect(report.weekdays.map((day) => day.weekday)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);

    // 4 May 2026 is a Monday.
    const monday = report.weekdays.find((day) => day.label === "Monday");
    expect(Number(monday?.revenue)).toBeGreaterThan(0);
    expect(
      report.weekdays.filter((day) => Number(day.revenue) === 0),
    ).toHaveLength(6);
  });
});

describe("ratios and the health indicator", () => {
  it("computes a gross margin that matches the statements", async () => {
    const fixture = await createCompany();
    await sell(fixture, {
      productId: fixture.soapId,
      quantity: 100,
      rate: 40,
      date: MID,
    });

    const report = await analyticsFor(fixture);
    const statements = await getFinancialStatements({
      companyId: fixture.companyId,
      from: report.from,
      to: report.to,
    });

    const grossMargin = report.ratios.find(
      (ratio) => ratio.key === "grossMargin",
    );
    expect(grossMargin?.value).toBeCloseTo(
      statements.trading.grossMarginPercent ?? 0,
      1,
    );
  });

  it("gives a reason rather than a zero for what it cannot compute", async () => {
    const fixture = await createCompany();
    const report = await analyticsFor(fixture);

    for (const ratio of report.ratios) {
      if (ratio.value === null) expect(ratio.unavailable).not.toBeNull();
    }
    // A company that has not traded has nothing to say about margins.
    const netMargin = report.ratios.find((ratio) => ratio.key === "netMargin");
    expect(netMargin?.value).toBeNull();
  });

  it("withholds a health score where there is too little to measure", async () => {
    const fixture = await createCompany();
    const report = await analyticsFor(fixture);

    expect(report.health.score).toBeNull();
    expect(report.health.unavailable).toMatch(/not enough trading/i);
  });

  it("scores once the books have something in them", async () => {
    const fixture = await createCompany();
    await sell(fixture, {
      productId: fixture.soapId,
      quantity: 500,
      rate: 40,
      date: EARLY,
    });

    const report = await analyticsFor(fixture);
    expect(report.health.score).not.toBeNull();
    expect(report.health.score ?? -1).toBeGreaterThanOrEqual(0);
    expect(report.health.score ?? 101).toBeLessThanOrEqual(100);
  });
});

describe("an empty period", () => {
  it("says so rather than showing zeroes that look like findings", async () => {
    const fixture = await createCompany();
    const report = await analyticsFor(fixture);

    expect(report.empty).toBe(true);
    expect(report.trend).toHaveLength(0);
    expect(report.products).toHaveLength(0);
    expect(report.customers).toHaveLength(0);
  });
});

describe("tenant isolation", () => {
  it("never reads another company's sales, products or customers", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);

    await sell(mine, {
      productId: mine.riceId,
      quantity: 10,
      rate: 100,
      date: MID,
    });
    await sell(theirs, {
      productId: theirs.riceId,
      quantity: 900,
      rate: 100,
      date: MID,
    });
    await sell(theirs, {
      productId: theirs.soapId,
      quantity: 900,
      rate: 40,
      date: MID,
    });

    const report = await analyticsFor(mine);
    expect(report.revenue.current).toBe(toStorageString(1_000));
    expect(report.products).toHaveLength(1);
    expect(report.customers).toHaveLength(1);
    expect(report.bills.current).toBe(1);

    const other = await analyticsFor(theirs);
    expect(other.products).toHaveLength(2);
    expect(Number(other.revenue.current)).toBe(126_000);
  });
});

/**
 * What the breakdowns say a product earned.
 *
 * The first block in this file holds the trend to the statements, and it holds
 * because the trend is read from the ledger: a sales return debits Sales
 * Returns, which is an income account of debit nature in the trading section,
 * so it comes off revenue on its own.
 *
 * The breakdowns underneath it are read from the documents instead — sale items
 * for products and categories, sale headers for customers. A void is excluded
 * by the sale's status, so that much is handled. A return is not a status: it
 * is a separate document, and none of the three subtracted it.
 *
 * So a shop that sold and was given goods back saw one revenue in the chart at
 * the top of the page and a larger one in the tables underneath, on the same
 * page for the same period. The tables were the gross figure — what went out of
 * the door, not what the business kept — and the product that was returned most
 * looked like the one that sold best.
 */
describe("the breakdowns cannot disagree with the trend either", () => {
  async function soldAndPartlyReturned() {
    const fixture = await createCompany();

    const sale = await sell(fixture, {
      productId: fixture.riceId,
      quantity: 10,
      rate: 1_000,
      date: "2026-05-10",
    });

    const line = await prisma.saleItem.findFirstOrThrow({
      where: { saleId: sale.id },
      select: { id: true },
    });

    await createSalesReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        saleId: sale.id,
        returnDate: "2026-05-20",
        reason: "Four bags were damaged in transit",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: line.id, quantity: 4 }],
      },
    });

    return fixture;
  }

  /**
   * Payment days, on a shop that has never bought anything.
   *
   * This module's rule is stated at the top of `lib/analytics/ratios`: a ratio
   * it cannot compute honestly is null, not zero, and every null carries the
   * reason instead of a number. Payment days is guarded exactly that way —
   * nothing bought in the period, no basis to measure against.
   *
   * The guard could not fire, because the figure fed to it was every debit to
   * the Inventory account rather than what suppliers had billed. Three things
   * debit Inventory: a purchase, a sales return, and a stock adjustment in.
   * Only the first was bought from anybody. So one credit note from a customer
   * was enough to make the denominator non-zero, and the page told a shop with
   * no suppliers that it pays them in nil days.
   */
  it("has nothing to say about paying suppliers it never had", async () => {
    const fixture = await soldAndPartlyReturned();
    const analytics = await analyticsFor(fixture);

    const payable = analytics.ratios.find(
      (ratio) => ratio.key === "payableDays",
    );
    expect(payable?.value).toBeNull();
    expect(payable?.unavailable).toMatch(/nothing was bought/i);
  });

  it("does not let a return stand in for a cash cycle", async () => {
    // Cash cycle is stock days plus collection days less payment days, so a
    // payment-days figure conjured out of a credit note carries straight into
    // it. Better to say which leg is missing.
    const fixture = await soldAndPartlyReturned();
    const analytics = await analyticsFor(fixture);

    const cycle = analytics.ratios.find((ratio) => ratio.key === "cashCycle");
    expect(cycle?.value).toBeNull();
    expect(cycle?.unavailable).not.toBeNull();
  });

  it("counts what the supplier is owed, net of what went back", async () => {
    // A bill and a debit note for the whole of it leaves the shop owing
    // nothing and having bought nothing on balance. Counting the bill and
    // ignoring the note would put a denominator under payment days that the
    // supplier account does not carry.
    const fixture = await createCompany();
    const supplier = await createParty({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      kind: "SUPPLIER",
      input: {
        name: "Metro Wholesale",
        phone: "",
        email: "",
        gstin: "",
        pan: "",
        addressLine1: "",
        city: "",
        stateCode: "29",
        pincode: "",
        creditDays: 30,
        openingBalance: 0,
        openingNature: "CREDIT",
        notes: "",
      } as never,
    });

    const bill = await createPurchase({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        supplierId: supplier.id,
        supplierBillNo: "SB-NET-1",
        billDate: MID,
        paymentMode: "CREDIT",
        priceIncludesTax: false,
        claimInputCredit: true,
        notes: "",
        lines: [
          {
            productId: fixture.riceId,
            description: "",
            quantity: 10,
            rate: 500,
            discountPercent: 0,
          },
        ],
      } satisfies PurchaseInput,
    });

    const line = await prisma.purchaseItem.findFirstOrThrow({
      where: { purchaseId: bill.id },
      select: { id: true },
    });

    await createPurchaseReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        purchaseId: bill.id,
        returnDate: MID,
        reason: "The whole consignment was wrong",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: line.id, quantity: 10 }],
      } as never,
    });

    const analytics = await analyticsFor(fixture);
    const payable = analytics.ratios.find(
      (ratio) => ratio.key === "payableDays",
    );
    expect(payable?.value).toBeNull();
    expect(payable?.unavailable).toMatch(/nothing was bought/i);
  });

  it("takes a return off what the product earned", async () => {
    const fixture = await soldAndPartlyReturned();
    const analytics = await analyticsFor(fixture);

    const rice = analytics.products.find(
      (product) => product.productId === fixture.riceId,
    );

    // Ten bags out at ₹1,000, four back: six kept, ₹6,000 earned.
    expect(Number(rice?.quantity)).toBe(6);
    expect(Number(rice?.revenue)).toBe(6_000);
  });

  it("adds the products up to the revenue the trend reports", async () => {
    // The invariant the first block in this file asserts for the trend, asked
    // of the tables that sit under it. Two revenues on one page for one period
    // is one revenue too many.
    const fixture = await soldAndPartlyReturned();
    const analytics = await analyticsFor(fixture);

    const fromTrend = analytics.trend.reduce(
      (running, point) => running + Number(point.revenue),
      0,
    );
    const fromProducts = analytics.products.reduce(
      (running, product) => running + Number(product.revenue),
      0,
    );

    expect(fromProducts).toBeCloseTo(fromTrend, 2);
  });

  it("takes it off the customer and the category as well", async () => {
    // Same documents, sliced three ways. A fix that reached the product table
    // and not the other two would leave the page disagreeing with itself in a
    // quieter place.
    const fixture = await soldAndPartlyReturned();
    const analytics = await analyticsFor(fixture);

    const customers = analytics.customers.reduce(
      (running, customer) => running + Number(customer.revenue),
      0,
    );
    const categories = analytics.categories.reduce(
      (running, category) => running + Number(category.revenue),
      0,
    );

    expect(customers).toBeCloseTo(6_000, 2);
    expect(categories).toBeCloseTo(6_000, 2);

    // The revenue comes off; the bill does not. The customer was invoiced, and
    // a count that fell when the goods came back would say the shop had served
    // them fewer times than it did.
    const served = analytics.customers.reduce(
      (running, customer) => running + customer.bills,
      0,
    );
    expect(served).toBe(1);
  });
});
