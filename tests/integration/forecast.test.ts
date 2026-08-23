import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toStorageString } from "@/lib/money";
import type { RegisterInput } from "@/lib/validation/auth";
import type { ExpenseInput } from "@/lib/validation/expenses";
import type {
  CustomerInput,
  ProductInput,
  SupplierInput,
} from "@/lib/validation/master-data";
import type { PurchaseInput } from "@/lib/validation/purchases";
import type { SaleInput } from "@/lib/validation/sales";
import type { ReceiptInput } from "@/lib/validation/settlements";
import { registerOwner } from "@/server/auth/registration";
import {
  createExpense,
  listExpenseCategories,
} from "@/server/expenses/expense-service";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createPurchase } from "@/server/purchases/purchase-service";
import { createSale } from "@/server/sales/sale-service";
import { createReceipt } from "@/server/settlements/settlement-service";
import { getCashProjection } from "@/server/forecast/cash-projection";
import { getForecast } from "@/server/forecast/forecast-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Forecasting.
 *
 * Two things are being protected. The revenue projection has to refuse rather
 * than guess when there is too little history, and the cash projection has to
 * count only commitments that already exist — a projection that quietly
 * includes sales nobody has made is a projection that flatters.
 */

const createdCompanies: string[] = [];
const createdEmails: string[] = [];

/** The day every projection in this file is taken from. */
const TODAY = new Date("2026-08-12T00:00:00.000Z");
const DAY = 86_400_000;

const daysBefore = (days: number): string =>
  new Date(TODAY.getTime() - days * DAY).toISOString().slice(0, 10);
const daysAfter = (days: number): string =>
  new Date(TODAY.getTime() + days * DAY).toISOString().slice(0, 10);

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
      businessName: `Forecast ${uniqueSlug("Mart")}`,
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
      openingCashBalance: 100000,
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
  supplierId: string;
  rentCategoryId: string;
};

async function createCompany(): Promise<Fixture> {
  const email = `fcst-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
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
  const gst0 = taxonomy.taxRates.find((entry) => entry.code === "GST0");
  const rate = gst0 ?? taxonomy.taxRates[0];
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
      openingQuantity: 100_000,
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

  const supplier = await createParty({
    ...base,
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
    } satisfies SupplierInput,
  });

  const categories = await listExpenseCategories(result.companyId);
  const rent = categories.find((entry) => entry.name === "Rent");
  if (!rent) throw new Error("Provisioning did not seed categories");

  return {
    ...base,
    productId: product.id,
    customerId: customer.id,
    supplierId: supplier.id,
    rentCategoryId: rent.id,
  };
}

async function sell(
  fixture: Fixture,
  options: { date: string; amount: number; onCredit?: boolean },
) {
  return createSale({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      customerId: fixture.customerId,
      invoiceDate: options.date,
      paymentMode: options.onCredit === false ? "BANK" : "CREDIT",
      placeOfSupply: "",
      priceIncludesTax: false,
      notes: "",
      lines: [
        {
          productId: fixture.productId,
          description: "",
          quantity: options.amount / 100,
          rate: 100,
          discountPercent: 0,
        },
      ],
    } satisfies SaleInput,
  });
}

const forecastFor = (fixture: Fixture) =>
  getForecast({ companyId: fixture.companyId, today: TODAY });

const cashFor = (fixture: Fixture, weeks = 8) =>
  getCashProjection({ companyId: fixture.companyId, weeks, today: TODAY });

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

describe("the revenue projection", () => {
  it("refuses rather than guessing from three weeks of history", async () => {
    const fixture = await createCompany();
    for (const week of [1, 2, 3]) {
      await sell(fixture, { date: daysBefore(week * 7), amount: 10_000 });
    }

    const report = await forecastFor(fixture);
    expect(report.revenue.points).toHaveLength(0);
    expect(report.revenue.unavailable).toMatch(/at least 6 periods/i);
    // And it still says what it cannot see.
    expect(report.revenue.limitations.length).toBeGreaterThan(0);
  });

  it("projects once there is enough history, always as a range", async () => {
    const fixture = await createCompany();
    for (let week = 1; week <= 10; week += 1) {
      await sell(fixture, {
        date: daysBefore(week * 7),
        amount: 10_000 + week * 500,
      });
    }

    const report = await forecastFor(fixture);
    expect(report.revenue.unavailable).toBeNull();
    expect(report.revenue.points).toHaveLength(report.horizonWeeks);

    for (const point of report.revenue.points) {
      expect(Number(point.lower)).toBeLessThanOrEqual(Number(point.point));
      expect(Number(point.upper)).toBeGreaterThanOrEqual(Number(point.point));
      // Revenue cannot be negative, and the band is clamped rather than shown
      // running below nil.
      expect(Number(point.lower)).toBeGreaterThanOrEqual(0);
    }
  });

  it("widens the range the further out it reaches", async () => {
    const fixture = await createCompany();
    for (let week = 1; week <= 12; week += 1) {
      await sell(fixture, {
        date: daysBefore(week * 7),
        amount: 8_000 + (week % 3) * 2_000,
      });
    }

    const report = await forecastFor(fixture);
    const widths = report.revenue.points.map(
      (point) => Number(point.upper) - Number(point.lower),
    );
    expect(widths[widths.length - 1]).toBeGreaterThan(widths[0] ?? 0);
  });

  it("carries the history it fitted, so the chart shows what it read", async () => {
    const fixture = await createCompany();
    for (let week = 1; week <= 8; week += 1) {
      await sell(fixture, { date: daysBefore(week * 7), amount: 5_000 });
    }

    const report = await forecastFor(fixture);
    expect(report.revenue.history.length).toBe(report.revenue.observations);
    // The past is certain: its band is collapsed onto the line.
    for (const point of report.revenue.history) {
      expect(point.lower).toBe(point.point);
      expect(point.upper).toBe(point.point);
    }
  });

  it("names a deterministic method rather than a model", async () => {
    const fixture = await createCompany();
    const report = await forecastFor(fixture);
    expect(report.revenue.method).toBe("least_squares_trend_v1");
  });
});

describe("the cash projection", () => {
  it("opens at the cash and bank position", async () => {
    const fixture = await createCompany();
    const cash = await cashFor(fixture);
    expect(cash.openingCash).toBe(toStorageString(100_000));
  });

  it("counts an invoice in the week it falls due", async () => {
    const fixture = await createCompany();
    // Thirty days' credit on a sale made today: due inside week five.
    await sell(fixture, { date: daysBefore(0), amount: 50_000 });

    const cash = await cashFor(fixture);
    const due = cash.weeks.filter((week) => Number(week.receiptsDue) > 0);
    expect(due).toHaveLength(1);
    expect(due[0]?.receiptsDue).toBe(toStorageString(50_000));
    expect(cash.weeks.indexOf(due[0]!)).toBe(4);
  });

  it("counts nothing from sales that have not been made", async () => {
    // The whole reason this is a floor rather than a prediction.
    const fixture = await createCompany();
    for (let week = 1; week <= 10; week += 1) {
      await sell(fixture, {
        date: daysBefore(week * 7),
        amount: 20_000,
        onCredit: false,
      });
    }

    const cash = await cashFor(fixture);
    // Ten weeks of banked sales, all settled, so nothing is owed and no future
    // week has a receipt in it — even though the shop plainly keeps trading.
    expect(cash.weeks.every((week) => Number(week.receiptsDue) === 0)).toBe(
      true,
    );
    expect(cash.limitations.join(" ")).toMatch(
      /floor rather than a prediction/i,
    );
  });

  it("puts money already overdue into the first week", async () => {
    const fixture = await createCompany();
    // Due sixty days ago and still unpaid.
    await sell(fixture, { date: daysBefore(90), amount: 30_000 });

    const cash = await cashFor(fixture);
    expect(cash.overdueReceivables).toBe(toStorageString(30_000));
    expect(cash.weeks[0]?.receiptsDue).toBe(toStorageString(30_000));
  });

  it("takes running costs from what the shop has actually been spending", async () => {
    const fixture = await createCompany();
    // ₹13,000 of rent over the last quarter is ₹1,000 a week.
    for (let week = 1; week <= 13; week += 1) {
      await createExpense({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        branchId: null,
        input: {
          categoryId: fixture.rentCategoryId,
          expenseDate: daysBefore(week * 7),
          paymentMode: "BANK",
          supplierId: "",
          payeeName: "Landlord",
          amount: 1_000,
          taxPercent: 0,
          amountIncludesTax: true,
          claimInputCredit: false,
          isCapitalExpenditure: false,
          assetName: "",
          assetUsefulLifeMonths: 60,
          referenceNo: "",
          notes: "",
        } satisfies ExpenseInput,
      });
    }

    const cash = await cashFor(fixture);
    expect(Number(cash.weeklyRunningCost)).toBeCloseTo(1_000, 0);
    expect(cash.runningCostBasis).toMatch(/13 weeks/);
    expect(cash.runningCostBasis).toMatch(/excluding depreciation/i);
  });

  it("draws the closing balance down week by week", async () => {
    const fixture = await createCompany();
    await createExpense({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        categoryId: fixture.rentCategoryId,
        expenseDate: daysBefore(7),
        paymentMode: "BANK",
        supplierId: "",
        payeeName: "Landlord",
        amount: 13_000,
        taxPercent: 0,
        amountIncludesTax: true,
        claimInputCredit: false,
        isCapitalExpenditure: false,
        assetName: "",
        assetUsefulLifeMonths: 60,
        referenceNo: "",
        notes: "",
      } satisfies ExpenseInput,
    });

    const cash = await cashFor(fixture);
    for (let i = 0; i < cash.weeks.length; i += 1) {
      const week = cash.weeks[i]!;
      const expected =
        Number(week.openingCash) +
        Number(week.receiptsDue) -
        Number(week.paymentsDue) -
        Number(week.runningCosts);
      expect(Number(week.closingCash)).toBeCloseTo(expected, 2);
      if (i > 0) {
        expect(week.openingCash).toBe(cash.weeks[i - 1]!.closingCash);
      }
    }
  });

  it("names the week cash first runs short", async () => {
    const fixture = await createCompany();
    // A bill far larger than the cash on hand, due in three weeks.
    await createPurchase({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        supplierId: fixture.supplierId,
        supplierBillNo: uniqueSlug("SB").toUpperCase(),
        billDate: daysBefore(9),
        paymentMode: "CREDIT",
        priceIncludesTax: false,
        claimInputCredit: false,
        notes: "",
        lines: [
          {
            productId: fixture.productId,
            description: "",
            quantity: 5_000,
            rate: 60,
            discountPercent: 0,
          },
        ],
      } satisfies PurchaseInput,
    });

    const cash = await cashFor(fixture);
    expect(cash.firstShortfall).not.toBeNull();
    expect(Number(cash.firstShortfall?.amount)).toBeLessThan(0);
    expect(cash.weeks.some((week) => week.negative)).toBe(true);
  });

  it("says nothing about lateness until an invoice has been settled", async () => {
    const fixture = await createCompany();
    await sell(fixture, { date: daysBefore(10), amount: 10_000 });

    const cash = await cashFor(fixture);
    expect(cash.latenessDays).toBeNull();
    expect(cash.latenessBasis).toMatch(/nothing to measure/i);
    // With nothing to shift by, the two lines are the same.
    for (const week of cash.weeks) {
      expect(week.closingCashIfLate).toBe(week.closingCash);
    }
  });

  it("measures how late customers actually are, from settlements", async () => {
    const fixture = await createCompany();
    // Invoiced 60 days ago on 30 days' credit, settled 10 days ago: 20 days
    // past the due date.
    const sale = await sell(fixture, { date: daysBefore(60), amount: 10_000 });
    await createReceipt({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        kind: "CUSTOMER",
        partyId: fixture.customerId,
        date: daysBefore(10),
        paymentMode: "BANK",
        amount: 10_000,
        referenceNo: "",
        notes: "",
        allocations: [{ documentId: sale.id, amount: 10_000 }],
      } satisfies ReceiptInput,
    });

    const cash = await cashFor(fixture);
    expect(cash.latenessDays).toBe(20);
    expect(cash.latenessBasis).toMatch(/20 days past the due date/);
  });

  it("shifts the late line by exactly that many days", async () => {
    const fixture = await createCompany();
    const settled = await sell(fixture, {
      date: daysBefore(60),
      amount: 10_000,
    });
    await createReceipt({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        kind: "CUSTOMER",
        partyId: fixture.customerId,
        date: daysBefore(10),
        paymentMode: "BANK",
        amount: 10_000,
        referenceNo: "",
        notes: "",
        allocations: [{ documentId: settled.id, amount: 10_000 }],
      } satisfies ReceiptInput,
    });

    // An open invoice due in week five. Twenty days later is week eight.
    await sell(fixture, { date: daysAfter(0), amount: 40_000 });

    const cash = await cashFor(fixture);
    const onTime = cash.weeks.findIndex(
      (week) => Number(week.receiptsDue) >= 40_000,
    );
    expect(onTime).toBe(4);
    // The on-time line has the money three weeks before the late line does,
    // and that gap is what slow collection costs.
    expect(Number(cash.weeks[onTime]!.closingCash)).toBeGreaterThan(
      Number(cash.weeks[onTime]!.closingCashIfLate),
    );
  });
});

describe("tenant isolation", () => {
  it("never projects another company's invoices or costs", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);

    await sell(theirs, { date: daysBefore(0), amount: 900_000 });
    for (let week = 1; week <= 10; week += 1) {
      await sell(theirs, { date: daysBefore(week * 7), amount: 50_000 });
    }

    const cash = await cashFor(mine);
    expect(cash.weeks.every((week) => Number(week.receiptsDue) === 0)).toBe(
      true,
    );

    const report = await forecastFor(mine);
    expect(report.revenue.unavailable).not.toBeNull();

    const other = await forecastFor(theirs);
    expect(other.revenue.unavailable).toBeNull();
  });
});

/**
 * Money a credit note has already cancelled.
 *
 * The projection rolls forward commitments that already exist, and a credit
 * note cancels one as surely as a payment settles it. Only the payments were
 * counted, so an invoice half credited back was still expected in full and
 * still landed in a particular week.
 *
 * The direction is what makes it worth a test. This figure is offered as a
 * floor rather than a prediction — the interface says so in those words — and a
 * floor that counts money nobody is going to send is the one a shop walks off.
 */
describe("the cash projection against credit notes", () => {
  const iso = TODAY.toISOString().slice(0, 10);

  async function creditBack(fixture: Fixture, saleId: string, units: number) {
    const { createSalesReturn, returnableLines } =
      await import("@/server/returns/sales-return-service");
    const lines = await returnableLines({
      companyId: fixture.companyId,
      saleId,
    });
    await createSalesReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        saleId,
        returnDate: iso,
        reason: "",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: lines[0]!.lineId, quantity: units }],
      },
    });
  }

  const receiptsDue = (projection: { weeks: Array<{ receiptsDue: string }> }) =>
    projection.weeks.reduce(
      (total, week) => total + Number(week.receiptsDue),
      0,
    );

  it("stops expecting the part that was credited back", async () => {
    const fixture = await createCompany();
    const sale = await sell(fixture, { date: iso, amount: 10_000 });

    const before = receiptsDue(await cashFor(fixture));
    expect(before).toBeCloseTo(10_000, 2);

    await creditBack(fixture, sale.id, 50);

    const after = receiptsDue(await cashFor(fixture));
    expect(after).toBeCloseTo(5_000, 2);
  }, 90_000);

  it("drops an invoice credited back in full", async () => {
    // Not merely reduced: there is nothing left to arrive, so it should not sit
    // in a week at all.
    const fixture = await createCompany();
    const sale = await sell(fixture, { date: iso, amount: 10_000 });
    await creditBack(fixture, sale.id, 100);

    expect(receiptsDue(await cashFor(fixture))).toBeCloseTo(0, 2);
  }, 90_000);

  it("leaves an invoice nothing has come back against alone", async () => {
    // The ordinary path, which the netting must not quietly reduce.
    const fixture = await createCompany();
    await sell(fixture, { date: iso, amount: 10_000 });

    expect(receiptsDue(await cashFor(fixture))).toBeCloseTo(10_000, 2);
  }, 90_000);
});

/**
 * A shop younger than the window it is being averaged over.
 *
 * The running cost is thirteen weeks of spending divided by thirteen, and the
 * revenue projection two blocks up refuses to guess from three weeks of history
 * rather than doing the equivalent. The cash side divided by thirteen whatever
 * the books held.
 *
 * So a shop two weeks old with ₹2,000 of rent behind it was told its running
 * cost was ₹154 a week rather than ₹1,000 — and the week it runs out of money,
 * which is the whole output of this page, moved months into the future. The
 * error is in the dangerous direction, on the businesses least able to absorb
 * it: a shop that has just opened is the one that most needs to know when the
 * cash runs out, and is the one this told it never would.
 *
 * The advisor makes the same guard next door and says why — a shop that
 * registered this morning being told its stock has sat still for four months is
 * how somebody learns to ignore the page. This is that, with money.
 */
describe("running costs on books younger than the window", () => {
  async function shopOpenedTwoWeeksAgo() {
    const fixture = await createCompany();

    for (const week of [1, 2]) {
      await createExpense({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        branchId: null,
        input: {
          categoryId: fixture.rentCategoryId,
          expenseDate: daysBefore(week * 7),
          paymentMode: "BANK",
          supplierId: "",
          payeeName: "Landlord",
          amount: 1_000,
          taxPercent: 0,
          amountIncludesTax: true,
          claimInputCredit: false,
          isCapitalExpenditure: false,
          assetName: "",
          assetUsefulLifeMonths: 60,
          referenceNo: "",
          notes: "",
        } satisfies ExpenseInput,
      });
    }

    return fixture;
  }

  it("averages over the weeks the books cover, not the weeks in the window", async () => {
    const fixture = await shopOpenedTwoWeeksAgo();
    const cash = await cashFor(fixture);

    // ₹2,000 over the two weeks this shop has existed is ₹1,000 a week.
    expect(Number(cash.weeklyRunningCost)).toBeCloseTo(1_000, 0);
  });

  it("says how far back it actually looked", async () => {
    // The sentence under the figure claimed thirteen weeks whatever the books
    // held, which is the part a person would have checked it against.
    const fixture = await shopOpenedTwoWeeksAgo();
    const cash = await cashFor(fixture);

    expect(cash.runningCostBasis).not.toMatch(/13 weeks/);
    expect(cash.runningCostBasis).toMatch(/2 weeks/);
  });
});
