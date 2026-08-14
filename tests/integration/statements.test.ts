import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { toStorageString } from "@/lib/money";
import type { RegisterInput } from "@/lib/validation/auth";
import type { CustomerInput, ProductInput } from "@/lib/validation/master-data";
import type { ExpenseInput } from "@/lib/validation/expenses";
import type { SaleInput } from "@/lib/validation/sales";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale } from "@/server/sales/sale-service";
import {
  createExpense,
  listExpenseCategories,
} from "@/server/expenses/expense-service";
import {
  createPayment,
  createReceipt,
} from "@/server/settlements/settlement-service";
import { listAccountMeta } from "@/server/accounting/balances";
import { createManualEntry } from "@/server/accounting/journal-service";
import {
  getFinancialStatements,
  summarise,
} from "@/server/accounting/statements-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * The financial statements.
 *
 * The arithmetic is the whole test. A balance sheet that does not balance is the
 * classic failure of a hand-rolled statement, and the classic cause is mixing a
 * period figure with a position figure — so most of what follows is deliberately
 * awkward cases: contra accounts, drawings, a sub-window, a loss.
 */

const createdCompanies: string[] = [];
const createdEmails: string[] = [];
const TODAY = new Date().toISOString().slice(0, 10);
const YEAR_START = "2026-04-01";
const YEAR_END = "2027-03-31";

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
      businessName: "Statements Test Mart",
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
      openingCashBalance: 50000,
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
  const email = `stmt-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
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
  if (!unit || !gst0) throw new Error("Provisioning is incomplete");

  // Zero-rated, so the arithmetic under test is the statements' and not GST's.
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
      taxRateId: gst0.id,
      purchasePrice: 60,
      sellingPrice: 100,
      mrp: 0,
      isStockTracked: true,
      openingQuantity: 100,
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
      stateCode: "",
      pincode: "",
      creditDays: 30,
      creditLimit: 500000,
      openingBalance: 0,
      openingNature: "DEBIT",
      notes: "",
    } satisfies CustomerInput,
  });

  return { ...base, productId: product.id, customerId: customer.id };
}

async function sell(fixture: Fixture, quantity: number, date = TODAY) {
  return createSale({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      customerId: fixture.customerId,
      invoiceDate: date,
      paymentMode: "CREDIT",
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

async function spend(fixture: Fixture, amount: number, category = "Rent") {
  const categories = await listExpenseCategories(fixture.companyId);
  const found = categories.find((entry) => entry.name === category);
  if (!found) throw new Error(`No ${category} category`);

  return createExpense({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      categoryId: found.id,
      expenseDate: TODAY,
      paymentMode: "CASH",
      supplierId: "",
      payeeName: "",
      amount,
      taxPercent: 0,
      amountIncludesTax: true,
      claimInputCredit: false,
      isCapitalExpenditure: false,
      assetName: "",
      assetUsefulLifeMonths: 0,
      referenceNo: "",
      notes: "",
    } satisfies ExpenseInput,
  });
}

const statementsFor = (fixture: Fixture, from = YEAR_START, to = YEAR_END) =>
  getFinancialStatements({ companyId: fixture.companyId, from, to });

const lineNamed = (
  groups: Array<{ lines: Array<{ name: string; amount: string }> }>,
  name: string,
) => groups.flatMap((group) => group.lines).find((line) => line.name === name);

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

describe("the trading account", () => {
  it("reads revenue less the cost of what was sold", async () => {
    const fixture = await createCompany();
    await sell(fixture, 4); // ₹400 at a ₹60 cost each

    const { trading } = await statementsFor(fixture);

    expect(trading.revenueTotal).toBe(toStorageString(400));
    expect(trading.costOfSalesTotal).toBe(toStorageString(240));
    expect(trading.grossProfit).toBe(toStorageString(160));
    expect(trading.grossMarginPercent).toBe(40);
  });

  it("has no Purchases line, because purchases go into stock", async () => {
    // This system keeps perpetual inventory. A periodic trading account would
    // print ₹0 against Purchases and mislead anyone who knows the textbook form.
    const fixture = await createCompany();
    await sell(fixture, 4);

    const { trading } = await statementsFor(fixture);
    expect(lineNamed(trading.costOfSales, "Purchases")).toBeUndefined();
    expect(lineNamed(trading.costOfSales, "Opening Stock")).toBeUndefined();
    expect(lineNamed(trading.costOfSales, "Cost of Goods Sold")?.amount).toBe(
      toStorageString(240),
    );
  });

  it("reports no margin rather than a fake one when nothing sold", async () => {
    const fixture = await createCompany();
    const { trading } = await statementsFor(fixture);

    expect(trading.revenueTotal).toBe(toStorageString(0));
    expect(trading.grossMarginPercent).toBeNull();
  });

  it("measures only the period given", async () => {
    const fixture = await createCompany();
    await sell(fixture, 3, "2026-05-10");
    await sell(fixture, 5, "2026-08-20");

    const may = await statementsFor(fixture, "2026-05-01", "2026-05-31");
    expect(may.trading.revenueTotal).toBe(toStorageString(300));

    const year = await statementsFor(fixture);
    expect(year.trading.revenueTotal).toBe(toStorageString(800));
  });
});

describe("the profit and loss account", () => {
  it("takes running costs off the gross profit", async () => {
    const fixture = await createCompany();
    await sell(fixture, 10); // ₹1,000 revenue, ₹600 cost, ₹400 gross
    await spend(fixture, 150); // rent

    const { profitAndLoss } = await statementsFor(fixture);

    expect(profitAndLoss.grossProfit).toBe(toStorageString(400));
    expect(profitAndLoss.expensesTotal).toBe(toStorageString(150));
    expect(profitAndLoss.netProfit).toBe(toStorageString(250));
    expect(profitAndLoss.netMarginPercent).toBe(25);
    expect(lineNamed(profitAndLoss.expenses, "Rent")?.amount).toBe(
      toStorageString(150),
    );
  });

  it("counts other income below the gross-profit line, not in revenue", async () => {
    const fixture = await createCompany();
    await sell(fixture, 10);
    await createReceipt({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        kind: "OTHER_INCOME",
        partyId: "",
        date: TODAY,
        paymentMode: "CASH",
        amount: 500,
        referenceNo: "",
        notes: "",
        allocations: [],
      },
    });

    const { trading, profitAndLoss } = await statementsFor(fixture);

    // Interest is not trading revenue, so the gross margin is untouched.
    expect(trading.revenueTotal).toBe(toStorageString(1000));
    expect(trading.grossMarginPercent).toBe(40);
    expect(profitAndLoss.otherIncomeTotal).toBe(toStorageString(500));
    expect(profitAndLoss.netProfit).toBe(toStorageString(900));
  });

  it("reports a loss as a loss", async () => {
    const fixture = await createCompany();
    await sell(fixture, 2); // ₹200 revenue, ₹120 cost, ₹80 gross
    await spend(fixture, 5000);

    const { profitAndLoss } = await statementsFor(fixture);
    expect(Number(profitAndLoss.netProfit)).toBeLessThan(0);
    expect(profitAndLoss.netProfit).toBe(toStorageString(-4920));
  });

  it("does not treat drawings as an expense", async () => {
    const fixture = await createCompany();
    await sell(fixture, 10);
    await createPayment({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        kind: "DRAWINGS",
        partyId: "",
        date: TODAY,
        paymentMode: "CASH",
        amount: 9000,
        referenceNo: "",
        notes: "",
        allocations: [],
      },
    });

    const { profitAndLoss, balanceSheet } = await statementsFor(fixture);

    expect(profitAndLoss.expensesTotal).toBe(toStorageString(0));
    expect(profitAndLoss.netProfit).toBe(toStorageString(400));
    // It reduces the owner's stake instead.
    expect(lineNamed(balanceSheet.equity, "Drawings")?.amount).toBe(
      toStorageString(-9000),
    );
    expect(balanceSheet.balanced).toBe(true);
  });
});

describe("the balance sheet", () => {
  it("balances for a company that has traded and spent", async () => {
    const fixture = await createCompany();
    await sell(fixture, 10);
    await spend(fixture, 150);

    const { balanceSheet } = await statementsFor(fixture);

    expect(balanceSheet.balanced).toBe(true);
    expect(balanceSheet.difference).toBe(toStorageString(0));
    expect(balanceSheet.assetsTotal).toBe(balanceSheet.fundingTotal);
  });

  it("carries profit not yet closed into the owner's stake", async () => {
    const fixture = await createCompany();
    await sell(fixture, 10);
    await spend(fixture, 150);

    const { profitAndLoss, balanceSheet } = await statementsFor(fixture);

    // Nothing has closed the income and expense accounts, so what the period
    // earned is shown inside capital. Without it the sheet would be out by
    // exactly the profit.
    expect(balanceSheet.earningsToDate).toBe(profitAndLoss.netProfit);
    expect(Number(balanceSheet.equityTotal)).toBeCloseTo(
      Number(balanceSheet.equity.reduce((sum, g) => sum + Number(g.total), 0)) +
        Number(balanceSheet.earningsToDate),
      2,
    );
  });

  it("balances on a sub-window, carrying earlier earnings too", async () => {
    const fixture = await createCompany();
    await sell(fixture, 4, "2026-05-10"); // earlier period
    await sell(fixture, 6, "2026-08-20"); // the window under test

    const august = await statementsFor(fixture, "2026-08-01", "2026-08-31");

    // The P&L shows August only…
    expect(august.trading.revenueTotal).toBe(toStorageString(600));
    expect(august.profitAndLoss.netProfit).toBe(toStorageString(240));
    // …while the sheet carries everything earned up to the closing date.
    expect(august.balanceSheet.earningsToDate).toBe(toStorageString(400));
    expect(august.balanceSheet.balanced).toBe(true);
  });

  it("nets a contra-asset off the assets rather than adding to them", async () => {
    const fixture = await createCompany();
    const meta = await listAccountMeta(fixture.companyId);
    const expense = meta.find(
      (entry) => entry.systemKey === SYSTEM_ACCOUNT.DEPRECIATION_EXPENSE,
    );
    const accumulated = meta.find(
      (entry) => entry.systemKey === SYSTEM_ACCOUNT.ACCUMULATED_DEPRECIATION,
    );

    const before = await statementsFor(fixture);

    await createManualEntry({
      companyId: fixture.companyId,
      branchId: null,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        entryDate: TODAY,
        voucherType: "DEPRECIATION",
        narration: "Depreciation for the year on the display fridge",
        referenceNo: "",
        lines: [
          {
            accountId: expense!.id,
            debit: 4000,
            credit: 0,
            narration: "",
            partyId: "",
          },
          {
            accountId: accumulated!.id,
            debit: 0,
            credit: 4000,
            narration: "",
            partyId: "",
          },
        ],
      },
    });

    const after = await statementsFor(fixture);

    expect(
      lineNamed(after.balanceSheet.assets, "Accumulated Depreciation")?.amount,
    ).toBe(toStorageString(-4000));
    expect(
      Number(before.balanceSheet.assetsTotal) -
        Number(after.balanceSheet.assetsTotal),
    ).toBeCloseTo(4000, 2);
    expect(after.balanceSheet.balanced).toBe(true);
  });

  it("shows opening cash as an asset funded by capital", async () => {
    const fixture = await createCompany();
    const { balanceSheet } = await statementsFor(fixture);

    // ₹50,000 cash in and ₹6,000 of opening stock, both from the owner.
    expect(lineNamed(balanceSheet.assets, "Cash in Hand")?.amount).toBe(
      toStorageString(50000),
    );
    expect(
      lineNamed(balanceSheet.assets, "Inventory / Closing Stock")?.amount,
    ).toBe(toStorageString(6000));
    expect(lineNamed(balanceSheet.equity, "Owner's Capital")?.amount).toBe(
      toStorageString(56000),
    );
    expect(balanceSheet.balanced).toBe(true);
  });

  it("shows what customers owe as an asset", async () => {
    const fixture = await createCompany();
    await sell(fixture, 4);

    const { balanceSheet } = await statementsFor(fixture);
    expect(lineNamed(balanceSheet.assets, "Accounts Receivable")?.amount).toBe(
      toStorageString(400),
    );
  });

  it("groups lines under the headings a balance sheet is read by", async () => {
    const fixture = await createCompany();
    await sell(fixture, 4);

    const { balanceSheet } = await statementsFor(fixture);
    const names = balanceSheet.assets.map((group) => group.name);

    expect(names).toContain("Cash & Bank");
    expect(names).toContain("Inventory");
    for (const group of balanceSheet.assets) {
      const sum = group.lines.reduce(
        (total, line) => total + Number(line.amount),
        0,
      );
      expect(Number(group.total)).toBeCloseTo(sum, 2);
    }
  });

  it("balances a company that has done nothing but register", async () => {
    const fixture = await createCompany();
    const statements = await statementsFor(fixture, "2020-01-01", "2020-12-31");

    expect(statements.balanceSheet.balanced).toBe(true);
    expect(statements.balanceSheet.assetsTotal).toBe(toStorageString(0));
    expect(statements.empty).toBe(true);
  });

  it("excludes what happened after the closing date", async () => {
    const fixture = await createCompany();
    await sell(fixture, 4, "2026-05-10");
    await sell(fixture, 9, "2026-09-10");

    const half = await statementsFor(fixture, YEAR_START, "2026-06-30");
    expect(half.trading.revenueTotal).toBe(toStorageString(400));
    expect(half.balanceSheet.balanced).toBe(true);
  });

  it("shows nobody else's figures", async () => {
    const alpha = await createCompany();
    const beta = await createCompany();
    await sell(beta, 20);
    await spend(beta, 3000);

    const mine = await statementsFor(alpha);
    expect(mine.trading.revenueTotal).toBe(toStorageString(0));
    expect(mine.profitAndLoss.netProfit).toBe(toStorageString(0));
    // Alpha's own opening cash and stock are there; beta's trading is not.
    expect(mine.balanceSheet.assetsTotal).toBe(toStorageString(56000));
    expect(mine.balanceSheet.balanced).toBe(true);
  });
});

describe("the plain-language reading", () => {
  it("explains the margin in rupees per hundred", async () => {
    const fixture = await createCompany();
    await sell(fixture, 10);
    await spend(fixture, 150);

    const notes = summarise(await statementsFor(fixture));
    expect(notes.join(" ")).toMatch(/For every ₹100 of sales, ₹40 was left/);
    expect(notes.join(" ")).toMatch(/Running the shop cost 15% of sales/);
    expect(notes.join(" ")).toMatch(/ended with a profit/);
  });

  it("says plainly when there is nothing to read", async () => {
    const fixture = await createCompany();
    const notes = summarise(await statementsFor(fixture));
    expect(notes).toEqual([
      "Nothing was sold in this period, so there is no margin to read.",
    ]);
  });

  it("names a loss as a loss and says why", async () => {
    const fixture = await createCompany();
    await sell(fixture, 2);
    await spend(fixture, 5000);

    const notes = summarise(await statementsFor(fixture));
    expect(notes.join(" ")).toMatch(/ended at a loss of 4920\.00/);
    expect(notes.join(" ")).toMatch(
      /did not cover the cost of running the shop/,
    );
  });

  it("recognises breaking even exactly", async () => {
    const fixture = await createCompany();
    await sell(fixture, 10); // ₹400 gross
    await spend(fixture, 400);

    const notes = summarise(await statementsFor(fixture));
    expect(notes.join(" ")).toMatch(/broke even exactly/);
  });
});
