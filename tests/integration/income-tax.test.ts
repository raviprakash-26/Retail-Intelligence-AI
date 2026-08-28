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
import type { PaymentInput } from "@/lib/validation/settlements";
import { registerOwner } from "@/server/auth/registration";
import {
  createExpense,
  listExpenseCategories,
} from "@/server/expenses/expense-service";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createPurchase } from "@/server/purchases/purchase-service";
import { createSale, voidSale } from "@/server/sales/sale-service";
import { createPayment } from "@/server/settlements/settlement-service";
import { getFinancialStatements } from "@/server/accounting/statements-service";
import { getTaxWorkingPaper } from "@/server/tax/income-tax-service";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import {
  assignableGroups,
  createAccount,
  setAccountActive,
} from "@/server/accounting/account-service";
import { listAccountMeta } from "@/server/accounting/balances";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * The income tax working paper.
 *
 * The point of these is that the computation is built out of the books rather
 * than alongside them. The book profit has to be the profit the statements
 * show; the disallowances have to be facts about vouchers that exist; and none
 * of it may reach across a tenant boundary.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

/** Inside the fiscal year that registration opens for a business today. */
const IN_YEAR = "2026-06-15";
const LATER_IN_YEAR = "2026-09-20";

type BusinessType = RegisterInput["business"]["businessType"];

function registrationInput(
  email: string,
  businessType: BusinessType = "SOLE_PROPRIETORSHIP",
): RegisterInput {
  // A distinct name per company: the slug is derived from it, and two tenants
  // registering under one name is a collision the fixture has no reason to
  // exercise.
  const businessName = `Income Tax ${uniqueSlug("Mart")}`;

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
      businessName,
      businessType,
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
      openingCashBalance: 500000,
      openingBankBalance: 500000,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

type Fixture = {
  companyId: string;
  userId: string;
  actorEmail: string;
  fiscalYearId: string;
  productId: string;
  customerId: string;
  supplierId: string;
  otherSupplierId: string;
  rentCategoryId: string;
};

async function createCompany(
  businessType: BusinessType = "SOLE_PROPRIETORSHIP",
): Promise<Fixture> {
  const email = `itax-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email, businessType));
  createdCompanies.push(result.companyId);

  const base = {
    companyId: result.companyId,
    userId: result.userId,
    actorEmail: "owner@example.com",
  };

  const year = await prisma.fiscalYear.findFirstOrThrow({
    where: { companyId: result.companyId },
    select: { id: true },
  });

  const taxonomy = await getProductTaxonomy(result.companyId);
  const unit = taxonomy.units.find((entry) => entry.code === "PCS");
  const gst18 = taxonomy.taxRates.find((entry) => entry.code === "GST18");
  if (!unit || !gst18) throw new Error("Provisioning is incomplete");

  const product = await createProduct({
    ...base,
    input: {
      sku: "WIDGET",
      name: "Widget",
      description: "",
      barcode: "",
      hsnCode: "1905",
      categoryId: "",
      unitId: unit.id,
      taxRateId: gst18.id,
      purchasePrice: 60,
      sellingPrice: 100,
      mrp: 0,
      isStockTracked: true,
      openingQuantity: 60000,
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
      gstin: "29AABCS1429B1ZX",
      pan: "",
      addressLine1: "",
      city: "",
      stateCode: "29",
      pincode: "",
      creditDays: 30,
      creditLimit: 10000000,
      openingBalance: 0,
      openingNature: "DEBIT",
      notes: "",
    } satisfies CustomerInput,
  });

  const supplierBase = {
    phone: "",
    email: "",
    pan: "",
    addressLine1: "",
    city: "",
    stateCode: "29",
    pincode: "",
    creditDays: 30,
    openingBalance: 0,
    openingNature: "CREDIT" as const,
    notes: "",
  };

  const supplier = await createParty({
    ...base,
    kind: "SUPPLIER",
    input: {
      ...supplierBase,
      name: "Metro Wholesale",
      gstin: "29AABCM4567N1Z8",
    } satisfies SupplierInput,
  });

  const otherSupplier = await createParty({
    ...base,
    kind: "SUPPLIER",
    input: {
      ...supplierBase,
      name: "Krishna Traders",
      gstin: "29AABCK7654P1Z3",
    } satisfies SupplierInput,
  });

  const categories = await listExpenseCategories(result.companyId);
  const rent = categories.find((entry) => entry.name === "Rent");
  if (!rent) throw new Error("Provisioning did not seed categories");

  return {
    ...base,
    fiscalYearId: year.id,
    productId: product.id,
    customerId: customer.id,
    supplierId: supplier.id,
    otherSupplierId: otherSupplier.id,
    rentCategoryId: rent.id,
  };
}

async function sell(fixture: Fixture, quantity: number, date = IN_YEAR) {
  return createSale({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      customerId: fixture.customerId,
      invoiceDate: date,
      paymentMode: "BANK",
      placeOfSupply: "",
      priceIncludesTax: false,
      notes: "",
      lines: [
        {
          productId: fixture.productId,
          description: "",
          quantity,
          rate: 100,
          discountPercent: 0,
        },
      ],
    } satisfies SaleInput,
  });
}

async function buy(
  fixture: Fixture,
  quantity: number,
  options: {
    date?: string;
    mode?: "CASH" | "CREDIT";
    supplierId?: string;
  } = {},
) {
  return createPurchase({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      supplierId: options.supplierId ?? fixture.supplierId,
      supplierBillNo: uniqueSlug("SB").toUpperCase(),
      billDate: options.date ?? IN_YEAR,
      paymentMode: options.mode ?? "CREDIT",
      priceIncludesTax: false,
      claimInputCredit: true,
      notes: "",
      lines: [
        {
          productId: fixture.productId,
          description: "",
          quantity,
          rate: 50,
          discountPercent: 0,
        },
      ],
    } satisfies PurchaseInput,
  });
}

async function spend(fixture: Fixture, overrides: Partial<ExpenseInput> = {}) {
  return createExpense({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      categoryId: fixture.rentCategoryId,
      expenseDate: IN_YEAR,
      paymentMode: "CASH",
      supplierId: "",
      payeeName: "Landlord",
      amount: 5000,
      taxPercent: 0,
      amountIncludesTax: true,
      claimInputCredit: false,
      isCapitalExpenditure: false,
      assetName: "",
      assetUsefulLifeMonths: 60,
      referenceNo: "",
      notes: "",
      ...overrides,
    } satisfies ExpenseInput,
  });
}

async function pay(fixture: Fixture, overrides: Partial<PaymentInput> = {}) {
  return createPayment({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    input: {
      kind: "SUPPLIER",
      partyId: fixture.supplierId,
      date: IN_YEAR,
      paymentMode: "CASH",
      amount: 15000,
      referenceNo: "",
      notes: "",
      allocations: [],
      ...overrides,
    } satisfies PaymentInput,
  });
}

const paperFor = async (fixture: Fixture) => {
  const paper = await getTaxWorkingPaper({
    companyId: fixture.companyId,
    fiscalYearId: fixture.fiscalYearId,
  });
  if (!paper) throw new Error("No working paper was produced");
  return paper;
};

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

describe("the computation starts from the books", () => {
  it("uses the profit the statements show, not one of its own", async () => {
    const fixture = await createCompany();
    await sell(fixture, 100);
    await spend(fixture);

    const paper = await paperFor(fixture);
    const statements = await getFinancialStatements({
      companyId: fixture.companyId,
      from: paper.fiscalYear.from,
      to: paper.fiscalYear.to,
    });

    // If these two ever disagree, one of the two reports is lying about the
    // same underlying entries.
    expect(paper.bookNetProfit).toBe(statements.profitAndLoss.netProfit);
    expect(paper.turnover).toBe(statements.trading.revenueTotal);
  });

  it("takes turnover net of GST", async () => {
    const fixture = await createCompany();
    await sell(fixture, 100); // ₹10,000 plus ₹1,800 of GST

    const paper = await paperFor(fixture);
    expect(paper.turnover).toBe(toStorageString(10_000));
  });

  it("drops a voided invoice out of turnover", async () => {
    const fixture = await createCompany();
    const sale = await sell(fixture, 100);
    await sell(fixture, 40);

    const before = await paperFor(fixture);
    await voidSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      saleId: sale.id,
      reason: "Raised against the wrong customer",
    });
    const after = await paperFor(fixture);

    expect(Number(after.turnover)).toBe(Number(before.turnover) - 10_000);
  });

  it("shows the adjustment for depreciation in both directions", async () => {
    const fixture = await createCompany();
    await sell(fixture, 500);
    await spend(fixture, {
      amount: 100_000,
      paymentMode: "BANK",
      isCapitalExpenditure: true,
      assetName: "Chest freezer",
      payeeName: "Cool Systems",
    });

    const paper = await paperFor(fixture);
    const labels = paper.computation.map((line) => line.label);

    expect(labels).toContain("Add: depreciation charged in the books");
    expect(labels).toContain("Less: depreciation under the Income-tax Act");

    // The Act's charge is 15% on plant and machinery, and the freezer was
    // bought with more than 180 days of the year left.
    expect(paper.depreciation.depreciation).toBe(toStorageString(15_000));

    const profit = Number(paper.bookNetProfit);
    const book = Number(paper.bookDepreciation);
    const act = Number(paper.depreciation.depreciation);
    expect(Number(paper.taxableIncome)).toBeCloseTo(profit + book - act, 2);
  });

  it("reports a loss as a loss rather than flooring it at nil", async () => {
    // A statement has to add up. A year that spent more than it earned has a
    // negative figure at the bottom, and quietly clamping it turns three lines
    // that should reconcile into three that do not.
    const fixture = await createCompany();
    await sell(fixture, 10); // ₹1,000 of turnover
    await spend(fixture, { amount: 60_000, paymentMode: "BANK" });

    const paper = await paperFor(fixture);
    expect(paper.loss).toBe(true);
    expect(Number(paper.taxableIncome)).toBeLessThan(0);

    const total = paper.computation.at(-1);
    expect(total?.label).toBe("Estimated loss from business");
    expect(total?.note).toMatch(/carried forward/i);

    const parts = paper.computation
      .slice(0, -1)
      .reduce((sum, line) => sum + Number(line.amount), 0);
    expect(Number(paper.taxableIncome)).toBeCloseTo(parts, 2);

    // There is no tax on a loss, and no refund either.
    for (const regime of paper.regimes) {
      expect(regime.normal.totalTax).toBe(toStorageString(0));
    }
    expect(paper.advanceTaxRequired).toBe(false);
    expect(paper.advanceTaxBasis).toMatch(/in loss/i);
  });

  it("says nothing has been computed for a business that has done nothing", async () => {
    const fixture = await createCompany();
    const paper = await paperFor(fixture);

    expect(paper.empty).toBe(true);
    expect(paper.turnover).toBe(toStorageString(0));
  });
});

describe("the assessment year", () => {
  it("is the year after the financial year", async () => {
    const fixture = await createCompany();
    const paper = await paperFor(fixture);

    const start = Number(paper.fiscalYear.from.slice(0, 4));
    expect(paper.assessmentYear).toBe(
      `${start + 1}-${String((start + 2) % 100).padStart(2, "0")}`,
    );
    expect(paper.ratesKnown).toBe(true);
  });

  it("says out loud when the rates were carried forward", async () => {
    const fixture = await createCompany();
    const paper = await paperFor(fixture);

    // The Finance Act for the year in progress has not been entered, so the
    // figures are computed on last year's rates and marked as such.
    if (paper.ratesProvisional) {
      expect(paper.basis).toMatch(/carried forward/i);
    } else {
      expect(paper.basis).toMatch(/Finance Act/i);
    }
  });
});

describe("cash paid above the section 40A(3) limit", () => {
  it("finds a single payment over the limit", async () => {
    const fixture = await createCompany();
    await sell(fixture, 500);
    await pay(fixture, { amount: 15_000 });

    const paper = await paperFor(fixture);
    expect(paper.flagged.cashPayments).toHaveLength(1);
    expect(paper.flagged.cashPayments[0]?.partyName).toBe("Metro Wholesale");
    expect(paper.flagged.cashPaymentsTotal).toBe(toStorageString(15_000));
  });

  it("adds up a day rather than looking at vouchers one at a time", async () => {
    // Three payments of ₹4,000 to the same supplier on the same day are caught;
    // splitting a payment to stay under the line is the thing the aggregation
    // exists to defeat.
    const fixture = await createCompany();
    await sell(fixture, 500);
    await pay(fixture, { amount: 4_000 });
    await pay(fixture, { amount: 4_000 });
    await pay(fixture, { amount: 4_000 });

    const paper = await paperFor(fixture);
    expect(paper.flagged.cashPayments).toHaveLength(1);
    expect(paper.flagged.cashPayments[0]?.amount).toBe(toStorageString(12_000));
    expect(paper.flagged.cashPayments[0]?.vouchers).toHaveLength(3);
  });

  it("keeps different people and different days apart", async () => {
    const fixture = await createCompany();
    await sell(fixture, 500);
    // ₹8,000 each to two suppliers on one day, and ₹8,000 again the next.
    // Nothing here reaches the limit for one person on one day.
    await pay(fixture, { amount: 8_000 });
    await pay(fixture, { amount: 8_000, partyId: fixture.otherSupplierId });
    await pay(fixture, { amount: 8_000, date: LATER_IN_YEAR });

    const paper = await paperFor(fixture);
    expect(paper.flagged.cashPayments).toHaveLength(0);
  });

  it("ignores money that did not move in cash", async () => {
    const fixture = await createCompany();
    await sell(fixture, 500);
    await pay(fixture, { amount: 90_000, paymentMode: "BANK" });
    await pay(fixture, { amount: 90_000, paymentMode: "UPI" });

    const paper = await paperFor(fixture);
    expect(paper.flagged.cashPayments).toHaveLength(0);
  });

  it("ignores drawings, which are not expenditure at all", async () => {
    const fixture = await createCompany();
    await sell(fixture, 500);
    await pay(fixture, { kind: "DRAWINGS", partyId: "", amount: 50_000 });

    const paper = await paperFor(fixture);
    expect(paper.flagged.cashPayments).toHaveLength(0);
  });

  it("catches a bill settled in cash at the counter", async () => {
    const fixture = await createCompany();
    await sell(fixture, 500);
    await buy(fixture, 400, { mode: "CASH" }); // ₹20,000 plus GST

    const paper = await paperFor(fixture);
    expect(paper.flagged.cashPayments).toHaveLength(1);
    expect(paper.flagged.cashPayments[0]?.amount).toBe(toStorageString(23_600));
  });

  it("keeps cash spent on an asset out of the disallowance", async () => {
    // A cash purchase of an asset is not disallowed as expenditure — it stops
    // counting towards the cost for depreciation instead, which is a different
    // consequence and belongs in a different place.
    const fixture = await createCompany();
    await sell(fixture, 500);
    await spend(fixture, {
      amount: 60_000,
      isCapitalExpenditure: true,
      assetName: "Delivery scooter",
      payeeName: "Ace Motors",
    });

    const paper = await paperFor(fixture);
    expect(paper.flagged.cashPayments).toHaveLength(0);
    expect(paper.flagged.cashCapitalPaymentsTotal).toBe(
      toStorageString(60_000),
    );
  });

  it("widens the income when the flagged items are disallowed", async () => {
    const fixture = await createCompany();
    await sell(fixture, 500);
    await pay(fixture, { amount: 25_000 });

    const paper = await paperFor(fixture);
    expect(Number(paper.taxableIncomeWithDisallowances)).toBeGreaterThan(
      Number(paper.taxableIncome),
    );
    // And the tax follows it, in both regimes.
    for (const regime of paper.regimes) {
      expect(regime.withDisallowances).not.toBeNull();
      expect(
        Number(regime.withDisallowances?.totalTax ?? 0),
      ).toBeGreaterThanOrEqual(Number(regime.normal.totalTax));
    }
  });
});

describe("depreciation under the Act", () => {
  it("puts an asset in a block and rates it", async () => {
    const fixture = await createCompany();
    await sell(fixture, 500);
    await spend(fixture, {
      amount: 80_000,
      paymentMode: "BANK",
      isCapitalExpenditure: true,
      assetName: "Billing computer",
      payeeName: "Tech Bazaar",
    });

    const paper = await paperFor(fixture);
    expect(paper.depreciation.blocks).toHaveLength(1);

    const block = paper.depreciation.blocks[0];
    // "Rent" is the category, so the name is what identifies it — and a
    // computer is depreciated at 40%.
    expect(block?.ratePercent).toBe(40);
    expect(block?.depreciation).toBe(toStorageString(32_000));
    expect(block?.assets[0]?.rateInferred).toBe(true);
  });

  /**
   * A capital expense that was voided.
   *
   * Voiding reverses the ledger — the debit to fixed assets is gone and the
   * books say the asset was never bought. The register is told too: the void
   * marks the asset inactive. Nothing read that, so the schedule went on
   * carrying the cost, and treated the void as a disposal for nil rather than
   * as an acquisition that never happened.
   *
   * Which is not a harmless difference. A disposal for nil leaves the cost
   * sitting in the block, so the next asset bought into the same block brings
   * `live` back above zero and depreciation is charged on the whole of it —
   * money the shop never spent, deducted from its taxable income.
   */
  it("forgets an asset whose purchase was voided", async () => {
    const fixture = await createCompany();
    await sell(fixture, 500);
    const capital = await spend(fixture, {
      amount: 80_000,
      paymentMode: "BANK",
      isCapitalExpenditure: true,
      assetName: "Billing computer",
      payeeName: "Tech Bazaar",
    });

    const { voidExpense } = await import("@/server/expenses/expense-service");
    await voidExpense({
      companyId: fixture.companyId,
      expenseId: capital.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      reason: "Booked against the wrong shop",
    });

    const paper = await paperFor(fixture);
    expect(paper.depreciation.blocks).toHaveLength(0);
    expect(Number(paper.depreciation.closingWdv)).toBe(0);
    expect(Number(paper.depreciation.depreciation)).toBe(0);
  });

  it("does not depreciate a voided asset through a later purchase", async () => {
    // The compounding case, and the one that costs tax. With the voided cost
    // left in the block, a real purchase afterwards revives it: the block has
    // an asset in it again, so the whole balance is depreciated.
    const fixture = await createCompany();
    await sell(fixture, 500);
    const capital = await spend(fixture, {
      amount: 80_000,
      paymentMode: "BANK",
      isCapitalExpenditure: true,
      assetName: "Billing computer",
      payeeName: "Tech Bazaar",
    });

    const { voidExpense } = await import("@/server/expenses/expense-service");
    await voidExpense({
      companyId: fixture.companyId,
      expenseId: capital.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      reason: "Booked against the wrong shop",
    });

    await spend(fixture, {
      amount: 50_000,
      paymentMode: "BANK",
      isCapitalExpenditure: true,
      assetName: "Replacement computer",
      payeeName: "Tech Bazaar",
    });

    const paper = await paperFor(fixture);
    // 40% of the ₹50,000 actually spent, and of nothing else.
    expect(Number(paper.depreciation.depreciation)).toBeCloseTo(20_000, 2);
  });

  it("charges half the rate on an asset bought late in the year", async () => {
    const fixture = await createCompany();
    await sell(fixture, 500);
    await spend(fixture, {
      expenseDate: "2027-02-01",
      amount: 100_000,
      paymentMode: "BANK",
      isCapitalExpenditure: true,
      assetName: "Chest freezer",
      payeeName: "Cool Systems",
    });

    const paper = await paperFor(fixture);
    expect(paper.depreciation.depreciation).toBe(toStorageString(7_500));
    expect(paper.depreciation.blocks[0]?.assets[0]?.halfRate).toBe(true);
  });

  it("has nothing to show when there are no assets", async () => {
    const fixture = await createCompany();
    await sell(fixture, 500);

    const paper = await paperFor(fixture);
    expect(paper.depreciation.blocks).toHaveLength(0);
    expect(paper.depreciation.depreciation).toBe(toStorageString(0));
  });
});

describe("section 44AD and the audit threshold", () => {
  it("is available to a proprietor and computes both rates", async () => {
    const fixture = await createCompany();
    await sell(fixture, 1000); // ₹1,00,000 of turnover, banked

    const paper = await paperFor(fixture);
    expect(paper.presumptive.eligible).toBe(true);
    expect(paper.presumptive.incomeAtFullRate).toBe(toStorageString(8_000));
    // Everything came in through the bank, so the whole of it is at 6%.
    expect(paper.presumptive.incomeAtSplitRate).toBe(toStorageString(6_000));
  });

  it("is closed to a limited liability partnership", async () => {
    const fixture = await createCompany("LLP");
    await sell(fixture, 1000);

    const paper = await paperFor(fixture);
    expect(paper.assessee).toBe("LLP");
    expect(paper.presumptive.eligible).toBe(false);
    expect(paper.regimes.every((regime) => regime.presumptive === null)).toBe(
      true,
    );
  });

  it("taxes a partnership firm at a flat rate with no regime choice", async () => {
    const fixture = await createCompany("PARTNERSHIP");
    await sell(fixture, 5000);

    const paper = await paperFor(fixture);
    expect(paper.assessee).toBe("FIRM");
    expect(paper.regimeChoice).toBe(false);
    expect(paper.regimes).toHaveLength(1);
    expect(paper.regimes[0]?.normal.flatRatePercent).toBe(30);
  });

  it("offers a proprietor both regimes, cheapest first", async () => {
    const fixture = await createCompany();
    await sell(fixture, 5000);

    const paper = await paperFor(fixture);
    expect(paper.regimeChoice).toBe(true);
    expect(paper.regimes.map((regime) => regime.regime).sort()).toEqual([
      "NEW",
      "OLD",
    ]);
    expect(Number(paper.regimes[0]?.normal.totalTax)).toBeLessThanOrEqual(
      Number(paper.regimes[1]?.normal.totalTax),
    );
  });

  it("measures the cash share from the ledger, not from the documents", async () => {
    const fixture = await createCompany();
    await sell(fixture, 500);
    await pay(fixture, { amount: 20_000, paymentMode: "CASH" });
    await pay(fixture, { amount: 60_000, paymentMode: "BANK" });

    const paper = await paperFor(fixture);
    expect(Number(paper.cashMix.cashPayments)).toBeGreaterThanOrEqual(20_000);
    expect(Number(paper.cashMix.bankPayments)).toBeGreaterThanOrEqual(60_000);
    expect(paper.cashMix.cashPaymentSharePercent).toBeGreaterThan(0);
    expect(paper.cashMix.cashPaymentSharePercent).toBeLessThan(100);
  });

  it("leaves the opening balance out of the year's receipts", async () => {
    // Money that was in the drawer when the year opened was not received
    // during it. Counting it would put a shop that banks everything over the
    // 5% cash line and cost it the relaxed ceilings it is entitled to.
    const fixture = await createCompany();
    await sell(fixture, 500); // banked

    const paper = await paperFor(fixture);
    expect(paper.cashMix.cashReceipts).toBe(toStorageString(0));
    expect(paper.cashMix.cashReceiptSharePercent).toBe(0);
  });

  it("does not require an audit on a small turnover", async () => {
    const fixture = await createCompany();
    await sell(fixture, 1000);

    const paper = await paperFor(fixture);
    expect(paper.audit.required).toBe(false);
    // Nothing moved in cash this year, so the ₹10 crore relaxation applies
    // rather than the ordinary ₹1 crore limit.
    expect(paper.audit.lowCash).toBe(true);
    expect(paper.audit.reason).toMatch(/₹10 crore limit applies/);
  });
});

describe("bills left unpaid", () => {
  it("lists a bill still outstanding past the time limit", async () => {
    const fixture = await createCompany();
    await sell(fixture, 500);
    await buy(fixture, 200, { date: "2026-04-10" });

    const paper = await paperFor(fixture);
    expect(paper.flagged.unpaidBills.length).toBeGreaterThan(0);
    expect(paper.flagged.unpaidBills[0]?.supplierName).toBe("Metro Wholesale");
    expect(paper.flagged.unpaidBills[0]?.daysAtYearEnd).toBeGreaterThan(45);
  });

  it("says nothing about a bill that was paid", async () => {
    const fixture = await createCompany();
    await sell(fixture, 500);
    await buy(fixture, 200, { date: "2026-04-10", mode: "CASH" });

    const paper = await paperFor(fixture);
    expect(paper.flagged.unpaidBills).toHaveLength(0);
  });

  /**
   * Goods sent back are not a debt left unpaid.
   *
   * What this list holds is disallowed expenditure under section 43B(h), so it
   * raises taxable income. Reading a bill as its total less what was paid
   * counts a debit note as money still owed, and a bill returned in full and
   * never paid appeared here in full — the working paper adding tax on the
   * value of goods the shop had sent back and did not owe a rupee for.
   */
  async function sendBack(fixture: Fixture, purchaseId: string, units: number) {
    const { createPurchaseReturn, returnableBillLines } =
      await import("@/server/returns/purchase-return-service");
    const lines = await returnableBillLines({
      companyId: fixture.companyId,
      purchaseId,
    });
    await createPurchaseReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        purchaseId,
        returnDate: "2026-04-12",
        reason: "",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: lines[0]!.lineId, quantity: units }],
      },
    });
  }

  it("says nothing about a bill returned in full", async () => {
    const fixture = await createCompany();
    await sell(fixture, 500);
    const bill = await buy(fixture, 200, { date: "2026-04-10" });
    await sendBack(fixture, bill.id, 200);

    const paper = await paperFor(fixture);
    expect(paper.flagged.unpaidBills).toHaveLength(0);
    expect(Number(paper.flagged.unpaidBillsTotal)).toBe(0);
  });

  it("counts only the part still owed on a bill returned in part", async () => {
    const fixture = await createCompany();
    await sell(fixture, 500);
    const bill = await buy(fixture, 200, { date: "2026-04-10" });

    const before = Number(
      (await paperFor(fixture)).flagged.unpaidBills[0]?.outstanding ?? 0,
    );
    await sendBack(fixture, bill.id, 50);

    const paper = await paperFor(fixture);
    expect(paper.flagged.unpaidBills).toHaveLength(1);
    const after = Number(paper.flagged.unpaidBills[0]?.outstanding ?? 0);
    // A quarter of the goods went back, so a quarter of the debt went with it.
    expect(after).toBeCloseTo(before * 0.75, 2);
  });

  /**
   * Money the shop has actually paid, against no bill in particular.
   *
   * Section 43B allows the deduction on payment. A shop that sent its supplier
   * the money has paid, whether or not anybody sat down afterwards and matched
   * it to bill numbers — the cash left the bank and the payable was credited.
   *
   * Reading the bill as its total less what was allocated to it counts that
   * money as still owed, so the working paper disallows expenditure the shop
   * has settled and raises its taxable income by the amount. The same fault as
   * the debit note above, and the same consequence: this list is tax, not a
   * figure on a screen.
   */
  it("says nothing about a bill paid without naming it", async () => {
    const fixture = await createCompany();
    await sell(fixture, 500);
    const bill = await buy(fixture, 200, { date: "2026-04-10" });

    await pay(fixture, {
      date: "2026-04-11",
      amount: Number(bill.totalAmount),
      allocations: [],
    });

    const paper = await paperFor(fixture);
    expect(paper.flagged.unpaidBills).toHaveLength(0);
    expect(Number(paper.flagged.unpaidBillsTotal)).toBe(0);
  });

  it("counts only the part still owed when some was paid on account", async () => {
    const fixture = await createCompany();
    await sell(fixture, 500);
    await buy(fixture, 200, { date: "2026-04-10" });

    const before = Number(
      (await paperFor(fixture)).flagged.unpaidBills[0]?.outstanding ?? 0,
    );
    await pay(fixture, {
      date: "2026-04-11",
      amount: before / 4,
      allocations: [],
    });

    const paper = await paperFor(fixture);
    expect(paper.flagged.unpaidBills).toHaveLength(1);
    expect(Number(paper.flagged.unpaidBills[0]?.outstanding ?? 0)).toBeCloseTo(
      before * 0.75,
      2,
    );
  });

  it("still lists a bill nothing has gone back against", async () => {
    // The ordinary path, which the netting must not quietly clear.
    const fixture = await createCompany();
    await sell(fixture, 500);
    await buy(fixture, 200, { date: "2026-04-10" });

    const paper = await paperFor(fixture);
    expect(paper.flagged.unpaidBills).toHaveLength(1);
    expect(Number(paper.flagged.unpaidBillsTotal)).toBeGreaterThan(0);
  });
});

describe("advance tax", () => {
  it("schedules four instalments on the prescribed dates", async () => {
    const fixture = await createCompany();
    await sell(fixture, 20_000); // enough profit to owe something

    const paper = await paperFor(fixture);
    expect(paper.advanceTax).toHaveLength(4);
    expect(paper.advanceTax.map((row) => row.cumulativePercent)).toEqual([
      15, 45, 75, 100,
    ]);

    const start = Number(paper.fiscalYear.from.slice(0, 4));
    expect(paper.advanceTax[0]?.dueDate).toBe(`${start}-06-15`);
    expect(paper.advanceTax[3]?.dueDate).toBe(`${start + 1}-03-15`);
  });

  it("is not required where there is barely any profit", async () => {
    const fixture = await createCompany();
    await sell(fixture, 10);

    const paper = await paperFor(fixture);
    expect(paper.advanceTaxRequired).toBe(false);
  });
});

describe("tenant isolation", () => {
  it("never reads another company's payments or assets", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);

    await sell(mine, 100);
    await sell(theirs, 900);
    await pay(theirs, { amount: 45_000 });
    await spend(theirs, {
      amount: 200_000,
      paymentMode: "BANK",
      isCapitalExpenditure: true,
      assetName: "Their delivery van",
      payeeName: "Ace Motors",
    });

    const paper = await paperFor(mine);
    expect(paper.turnover).toBe(toStorageString(10_000));
    expect(paper.flagged.cashPayments).toHaveLength(0);
    expect(paper.depreciation.blocks).toHaveLength(0);

    const other = await paperFor(theirs);
    expect(other.turnover).toBe(toStorageString(90_000));
    expect(other.flagged.cashPayments).toHaveLength(1);
    expect(other.depreciation.blocks).toHaveLength(1);
  });

  it("refuses a fiscal year that belongs to somebody else", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);
    await sell(theirs, 900);

    // An id is not a permission. Asking for another tenant's year returns
    // nothing rather than that tenant's figures.
    const paper = await getTaxWorkingPaper({
      companyId: mine.companyId,
      fiscalYearId: theirs.fiscalYearId,
    });
    expect(paper).toBeNull();
  });
});

/**
 * A bank account that was closed during the year.
 *
 * The cash share decides which presumptive ceiling a business gets — ₹2 crore
 * or ₹3 crore under section 44AD — and which audit threshold applies under
 * section 44AB. It is measured as cash receipts over all receipts, and the
 * denominator is built by finding the cash and bank accounts and adding up what
 * was debited to them.
 *
 * Those accounts were found with a read that returns only the active ones. A
 * shop that closed a bank account during the year, swept it to nil and retired
 * it from the chart — which is exactly what retiring is for, and is allowed
 * precisely because the balance is nil — lost every rupee that had gone through
 * it from the denominator. The cash it took over the counter stayed. So the
 * share rose, and it rose on the figure that decides the ceiling.
 *
 * The account is inactive today. It was not inactive when the money went
 * through it, and the question the working paper asks is about the year.
 */
describe("a bank account retired mid-year", () => {
  async function shopWithAClosedBankAccount() {
    const fixture = await createCompany();

    const groups = await assignableGroups({
      companyId: fixture.companyId,
      type: "ASSET",
    });
    const group = groups.find((entry) => entry.code === "1110") ?? groups[0]!;

    const second = await createAccount({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        code: "1119",
        name: "HDFC current account",
        groupId: group.id,
        type: "ASSET",
        subType: "CASH_AND_BANK",
        description: "",
      },
    });

    const meta = await listAccountMeta(fixture.companyId);
    const idOf = (key: string) => {
      const found = meta.find((entry) => entry.systemKey === key);
      if (!found) throw new Error(`No ${key} account`);
      return found.id;
    };

    const post = (
      lines: { accountId: string; debit?: number; credit?: number }[],
    ) =>
      prisma.$transaction((tx) =>
        postJournalEntry(tx, {
          companyId: fixture.companyId,
          entryDate: new Date(`${IN_YEAR}T00:00:00.000Z`),
          voucherType: "JOURNAL",
          createdById: fixture.userId,
          narration: "Trading through the second bank account",
          lines,
        }),
      );

    // ₹40,000 over the counter, and ₹9,60,000 through the second bank account.
    await post([
      { accountId: idOf(SYSTEM_ACCOUNT.CASH), debit: 40_000 },
      { accountId: idOf(SYSTEM_ACCOUNT.SALES), credit: 40_000 },
    ]);
    await post([
      { accountId: second.id, debit: 960_000 },
      { accountId: idOf(SYSTEM_ACCOUNT.SALES), credit: 960_000 },
    ]);
    // Emptied and closed, which is what makes retiring it allowed.
    await post([
      { accountId: idOf(SYSTEM_ACCOUNT.PURCHASES), debit: 960_000 },
      { accountId: second.id, credit: 960_000 },
    ]);

    await setAccountActive({
      companyId: fixture.companyId,
      accountId: second.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      isActive: false,
    });

    return fixture;
  }

  it("still counts what went through it", async () => {
    const fixture = await shopWithAClosedBankAccount();
    const paper = await paperFor(fixture);

    expect(Number(paper.cashMix.bankReceipts)).toBe(960_000);
    expect(Number(paper.cashMix.cashReceipts)).toBe(40_000);
    expect(Number(paper.cashMix.receipts)).toBe(1_000_000);
  });

  it("does not let the cash share rise because an account was retired", async () => {
    // 40,000 of 10,00,000 is 4% — under the 5% line that section 44AD turns on.
    // With the closed account's receipts missing the same shop reads as 100%
    // cash, which is the difference between the two ceilings.
    const fixture = await shopWithAClosedBankAccount();
    const paper = await paperFor(fixture);

    expect(paper.cashMix.cashReceiptSharePercent).toBe(4);
  });
});

/**
 * Cash banked, counted as though it had been earned twice.
 *
 * The manual entry form offers Contra and describes it in so many words —
 * "Money between your own accounts — cash banked, or drawn from the bank" — and
 * banking the day's takings is the single most ordinary thing an Indian shop
 * does with its money.
 *
 * The cash mix summed every debit and credit on a cash or bank account and
 * excluded only opening balances and closing entries. A deposit is a debit to
 * the bank and a credit to the till, so it was counted twice over: once as
 * money the business received, when it already had it, and once as money it
 * paid, when it had paid nobody. The same rupee appeared on both sides of a
 * test about how the business is paid.
 *
 * Both figures the page turns on move. The 6%/8% split under section 44AD is
 * taken from the receipt mix, so a shop whose every sale was in cash was shown
 * half its turnover as banked and its deemed income understated. The 5% tests
 * in sections 44AD and 44AB are taken from the same mix.
 *
 * A transfer within the business is not a receipt and not a payment, whatever
 * it is labelled: an entry whose every leg lands on a cash or bank account has
 * no counterparty outside the business, and there is no other kind of entry
 * that looks like that.
 */
describe("cash banked during the year", () => {
  function accountsOf(fixture: Awaited<ReturnType<typeof createCompany>>) {
    return listAccountMeta(fixture.companyId);
  }

  async function poster(
    fixture: Awaited<ReturnType<typeof createCompany>>,
    voucherType: "JOURNAL" | "CONTRA",
  ) {
    const meta = await accountsOf(fixture);
    const idOf = (key: string) => {
      const found = meta.find((entry) => entry.systemKey === key);
      if (!found) throw new Error(`No ${key} account`);
      return found.id;
    };
    const post = (
      narration: string,
      lines: { accountId: string; debit?: number; credit?: number }[],
    ) =>
      prisma.$transaction((tx) =>
        postJournalEntry(tx, {
          companyId: fixture.companyId,
          entryDate: new Date(`${IN_YEAR}T00:00:00.000Z`),
          voucherType,
          createdById: fixture.userId,
          narration,
          lines,
        }),
      );
    return { idOf, post };
  }

  async function shopThatBanksItsTakings() {
    const fixture = await createCompany();
    const takings = await poster(fixture, "JOURNAL");
    // Every sale over the counter, in cash.
    await takings.post("Counter takings for the year", [
      { accountId: takings.idOf(SYSTEM_ACCOUNT.CASH), debit: 1_000_000 },
      { accountId: takings.idOf(SYSTEM_ACCOUNT.SALES), credit: 1_000_000 },
    ]);
    // And banked, which is what the shop is told to record as a contra.
    const banking = await poster(fixture, "CONTRA");
    await banking.post("Cash banked", [
      { accountId: banking.idOf(SYSTEM_ACCOUNT.BANK), debit: 1_000_000 },
      { accountId: banking.idOf(SYSTEM_ACCOUNT.CASH), credit: 1_000_000 },
    ]);
    return fixture;
  }

  it("does not count a deposit as money received", async () => {
    const fixture = await shopThatBanksItsTakings();
    const paper = await paperFor(fixture);

    // Ten lakh came into this business, not twenty.
    expect(Number(paper.cashMix.receipts)).toBe(1_000_000);
    expect(Number(paper.cashMix.cashReceipts)).toBe(1_000_000);
    expect(Number(paper.cashMix.bankReceipts)).toBe(0);
    expect(paper.cashMix.cashReceiptSharePercent).toBe(100);
  });

  it("does not count a deposit as money paid", async () => {
    const fixture = await shopThatBanksItsTakings();
    const paper = await paperFor(fixture);

    expect(Number(paper.cashMix.cashPayments)).toBe(0);
    expect(Number(paper.cashMix.payments)).toBe(0);
  });

  it("charges the full presumptive rate on turnover that was taken in cash", async () => {
    // Nothing was received through banking channels, so none of the turnover
    // earns the 6% rate. Counting the deposit as a bank receipt made it look
    // like half, and took ₹1,00,000 off the income the section deems.
    const fixture = await shopThatBanksItsTakings();
    const paper = await paperFor(fixture);

    expect(paper.presumptive.digitalSharePercent).toBe(0);
    expect(paper.presumptive.incomeAtSplitRate).toBe(toStorageString(80_000));
    expect(paper.presumptive.incomeAtFullRate).toBe(toStorageString(80_000));
  });

  it("reads the entry rather than the label on it", async () => {
    // The form lets a manual entry be typed as Journal, Contra or
    // Depreciation, and nothing stops a shopkeeper choosing the first for a
    // deposit. Excluding by voucher type would take the label's word for it
    // and let the same double count back in under a different name.
    const fixture = await createCompany();
    const { idOf, post } = await poster(fixture, "JOURNAL");

    await post("Counter takings", [
      { accountId: idOf(SYSTEM_ACCOUNT.CASH), debit: 1_000_000 },
      { accountId: idOf(SYSTEM_ACCOUNT.SALES), credit: 1_000_000 },
    ]);
    await post("Cash banked, typed as a journal", [
      { accountId: idOf(SYSTEM_ACCOUNT.BANK), debit: 1_000_000 },
      { accountId: idOf(SYSTEM_ACCOUNT.CASH), credit: 1_000_000 },
    ]);

    const paper = await paperFor(fixture);
    expect(Number(paper.cashMix.receipts)).toBe(1_000_000);
    expect(Number(paper.cashMix.bankReceipts)).toBe(0);
    expect(Number(paper.cashMix.cashPayments)).toBe(0);
  });

  it("does not count a withdrawal as cash taken over the counter", async () => {
    // The other direction of the same entry. Drawing cash from the bank to pay
    // wages is not a cash receipt, and counting it as one is what pushes a
    // shop that banks everything over the 5% line it is entitled to be under.
    const fixture = await createCompany();
    const sales = await poster(fixture, "JOURNAL");
    await sales.post("Everything through the bank", [
      { accountId: sales.idOf(SYSTEM_ACCOUNT.BANK), debit: 1_000_000 },
      { accountId: sales.idOf(SYSTEM_ACCOUNT.SALES), credit: 1_000_000 },
    ]);
    const drawing = await poster(fixture, "CONTRA");
    await drawing.post("Drawn for wages", [
      { accountId: drawing.idOf(SYSTEM_ACCOUNT.CASH), debit: 20_000 },
      { accountId: drawing.idOf(SYSTEM_ACCOUNT.BANK), credit: 20_000 },
    ]);

    const paper = await paperFor(fixture);
    expect(Number(paper.cashMix.cashReceipts)).toBe(0);
    expect(paper.cashMix.cashReceiptSharePercent).toBe(0);
    expect(paper.audit.lowCash).toBe(true);
  });
});
