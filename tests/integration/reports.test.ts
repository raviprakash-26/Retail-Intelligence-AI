import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { add, money, toStorageString } from "@/lib/money";
import { toCsv } from "@/lib/reports/csv";
import type { RegisterInput } from "@/lib/validation/auth";
import type {
  CustomerInput,
  ProductInput,
  SupplierInput,
} from "@/lib/validation/master-data";
import type { ExpenseInput } from "@/lib/validation/expenses";
import type { PurchaseInput } from "@/lib/validation/purchases";
import type { SaleInput } from "@/lib/validation/sales";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale, voidSale, listSales } from "@/server/sales/sale-service";
import { createPurchase } from "@/server/purchases/purchase-service";
import {
  createExpense,
  listExpenses,
  listExpenseCategories,
} from "@/server/expenses/expense-service";
import { getTrialBalance } from "@/server/accounting/trial-balance-service";
import { getFinancialStatements } from "@/server/accounting/statements-service";
import { stockRows } from "@/server/inventory/inventory-report";
import { receivablesAgeing } from "@/server/settlements/outstanding";
import { runReport, ReportError } from "@/server/reports/report-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Reports.
 *
 * There is exactly one thing worth testing about this module, and it is not
 * whether a table renders. It is whether the report agrees with the service it
 * claims to be reporting. A reports module that computes its own figures will
 * eventually disagree with the page it summarises, and when the trial balance
 * says one thing and the trial balance *report* says another, neither is
 * usable by anybody.
 *
 * So almost every test below runs the report and the source, and compares.
 */

const createdCompanies: string[] = [];
const createdEmails: string[] = [];

const today = new Date().toISOString().slice(0, 10);
const YEAR_START = `${new Date().getUTCFullYear() - 1}-04-01`;

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
      businessName: `Reports ${uniqueSlug("Mart")}`,
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
      openingCashBalance: 100_000,
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
};

async function createCompany(): Promise<Fixture> {
  const email = `rep-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
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
  const gst18 = taxonomy.taxRates.find((entry) => entry.code === "GST18");
  if (!unit || !gst18) throw new Error("Provisioning is incomplete");

  const [product, customer, supplier] = await Promise.all([
    createProduct({
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
        openingQuantity: 100,
        openingRate: 60,
        minStockLevel: 0,
      } satisfies ProductInput,
    }),
    createParty({
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
    }),
    createParty({
      ...base,
      kind: "SUPPLIER",
      input: {
        name: "ABC Traders",
        phone: "",
        email: "",
        gstin: "29AABCA1234C1Z5",
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
    }),
  ]);

  return {
    ...base,
    productId: product.id,
    customerId: customer.id,
    supplierId: supplier.id,
  };
}

/** A company with one of everything posted, so the reports have figures. */
async function tradingCompany(): Promise<Fixture> {
  const fixture = await createCompany();

  await createSale({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      customerId: fixture.customerId,
      invoiceDate: today,
      paymentMode: "CREDIT",
      placeOfSupply: "",
      priceIncludesTax: false,
      notes: "",
      lines: [
        {
          productId: fixture.productId,
          description: "",
          quantity: 10,
          rate: 100,
          discountPercent: 0,
        },
      ],
    } satisfies SaleInput,
  });

  await createPurchase({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      supplierId: fixture.supplierId,
      supplierBillNo: "SUP-1",
      billDate: today,
      paymentMode: "CREDIT",
      priceIncludesTax: false,
      claimInputCredit: true,
      notes: "",
      lines: [
        {
          productId: fixture.productId,
          description: "",
          quantity: 20,
          rate: 60,
          discountPercent: 0,
        },
      ],
    } satisfies PurchaseInput,
  });

  const categories = await listExpenseCategories(fixture.companyId);
  const category = categories[0];
  if (!category) throw new Error("No expense category was provisioned");

  await createExpense({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      categoryId: category.id,
      expenseDate: today,
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
    } satisfies ExpenseInput,
  });

  return fixture;
}

const run = (companyId: string, key: string, period = {}) =>
  runReport({
    companyId,
    key,
    period: { from: YEAR_START, to: today, ...period },
  });

/** The figure printed on a row, by the label in its first column. */
function cellFor(
  rows: ReadonlyArray<{ cells: Record<string, string> }>,
  labelKey: string,
  label: string,
  valueKey: string,
): string | undefined {
  return rows.find((entry) => entry.cells[labelKey] === label)?.cells[valueKey];
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
}, 60_000);

describe("every report agrees with the service it reports", () => {
  it("the trial balance report is the trial balance", async () => {
    const fixture = await tradingCompany();
    const [report, source] = await Promise.all([
      run(fixture.companyId, "trial-balance"),
      getTrialBalance({
        companyId: fixture.companyId,
        from: YEAR_START,
        to: today,
      }),
    ]);

    const total = report.rows.at(-1)!;
    expect(total.cells.debit).toBe(source.totalDebit);
    expect(total.cells.credit).toBe(source.totalCredit);
    expect(total.cells.debit).toBe(total.cells.credit);
  }, 90_000);

  it("the profit and loss report is the statements service", async () => {
    const fixture = await tradingCompany();
    const [report, source] = await Promise.all([
      run(fixture.companyId, "profit-and-loss"),
      getFinancialStatements({
        companyId: fixture.companyId,
        from: YEAR_START,
        to: today,
      }),
    ]);

    expect(cellFor(report.rows, "line", "Net profit", "amount")).toBe(
      source.profitAndLoss.netProfit,
    );
    expect(cellFor(report.rows, "line", "Gross profit", "amount")).toBe(
      source.trading.grossProfit,
    );
    expect(cellFor(report.rows, "line", "Revenue", "amount")).toBe(
      source.trading.revenueTotal,
    );
  }, 90_000);

  it("the balance sheet report balances, and matches the statements service", async () => {
    const fixture = await tradingCompany();
    const [report, source] = await Promise.all([
      run(fixture.companyId, "balance-sheet"),
      getFinancialStatements({
        companyId: fixture.companyId,
        from: "1970-01-01",
        to: today,
      }),
    ]);

    expect(cellFor(report.rows, "line", "Total assets", "amount")).toBe(
      source.balanceSheet.assetsTotal,
    );
    expect(
      cellFor(report.rows, "line", "Liabilities and equity", "amount"),
    ).toBe(source.balanceSheet.fundingTotal);
    expect(source.balanceSheet.balanced).toBe(true);
  }, 90_000);

  it("the sales register totals what the sales service says was posted", async () => {
    const fixture = await tradingCompany();
    const [report, source] = await Promise.all([
      run(fixture.companyId, "sales-register"),
      listSales({ companyId: fixture.companyId, from: YEAR_START, to: today }),
    ]);

    const total = report.rows.at(-1)!;
    expect(total.cells.total).toBe(source.postedTotal);
    expect(total.cells.taxable).toBe(source.postedTaxable);
  }, 90_000);

  it("the expense report is the category breakdown the expenses page shows", async () => {
    const fixture = await tradingCompany();
    const [report, source] = await Promise.all([
      run(fixture.companyId, "expenses-by-category"),
      listExpenses({
        companyId: fixture.companyId,
        from: YEAR_START,
        to: today,
      }),
    ]);

    expect(report.rows.at(-1)!.cells.amount).toBe(source.postedExpense);
    for (const category of source.byCategory) {
      expect(cellFor(report.rows, "category", category.name, "amount")).toBe(
        category.total,
      );
    }
  }, 90_000);

  it("the stock report values stock at what the inventory service carries it at", async () => {
    const fixture = await tradingCompany();
    const [report, source] = await Promise.all([
      run(fixture.companyId, "stock-on-hand"),
      stockRows(fixture.companyId),
    ]);

    const expected = source.reduce(
      (sum, entry) => add(sum, entry.stockValue),
      money(0),
    );
    expect(report.rows.at(-1)!.cells.value).toBe(toStorageString(expected));
  }, 90_000);

  it("the receivables report is the ageing service", async () => {
    const fixture = await tradingCompany();
    const [report, source] = await Promise.all([
      run(fixture.companyId, "receivables-ageing"),
      receivablesAgeing(fixture.companyId),
    ]);

    const total = report.rows.at(-1)!;
    expect(total.cells.outstanding).toBe(source.summary.total);
    expect(total.cells.overdue).toBe(source.summary.overdue);
  }, 90_000);
});

describe("what the reports say about themselves", () => {
  it("lists a voided invoice but leaves it out of the total", async () => {
    // An invoice number that simply vanished is the gap a tax officer asks
    // about, and "it was raised and then voided" has to be visible somewhere.
    const fixture = await tradingCompany();
    const sale = await createSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        customerId: fixture.customerId,
        invoiceDate: today,
        paymentMode: "CASH",
        placeOfSupply: "",
        priceIncludesTax: false,
        notes: "",
        lines: [
          {
            productId: fixture.productId,
            description: "",
            quantity: 1,
            rate: 100,
            discountPercent: 0,
          },
        ],
      } satisfies SaleInput,
    });

    await voidSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      saleId: sale.id,
      reason: "Entered twice",
    });

    const report = await run(fixture.companyId, "sales-register");
    const voided = report.rows.find(
      (entry) => entry.cells.invoice === sale.invoiceNumber,
    );
    expect(voided?.cells.status).toBe("Voided");

    const source = await listSales({
      companyId: fixture.companyId,
      from: YEAR_START,
      to: today,
    });
    expect(report.rows.at(-1)!.cells.total).toBe(source.postedTotal);
  }, 90_000);

  it("says a GST summary is a preparation and not a filing", async () => {
    const fixture = await tradingCompany();
    const now = new Date();
    const report = await runReport({
      companyId: fixture.companyId,
      key: "gst-summary",
      period: { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 },
    });

    expect(report.notes.join(" ")).toMatch(/prepared for review/i);
    expect(report.notes.join(" ")).toMatch(/cannot file/i);
  }, 90_000);

  it("carries its notes into the exported file", async () => {
    // A caveat that only appears on screen is lost the moment somebody emails
    // the export, and the export is the copy that travels.
    const fixture = await tradingCompany();
    const report = await run(fixture.companyId, "profit-and-loss");
    const csv = toCsv(report);

    for (const note of report.notes) expect(csv).toContain(note);
    expect(csv).toContain(report.period);
  }, 90_000);

  it("exports the same figures it displayed", async () => {
    const fixture = await tradingCompany();
    const report = await run(fixture.companyId, "trial-balance");
    const csv = toCsv(report);
    const total = report.rows.at(-1)!;

    expect(csv).toContain(total.cells.debit!);
    // Storage form, not a rendered one — a spreadsheet cannot add up "₹1,000".
    expect(csv).not.toContain("₹");
  }, 90_000);

  it("reports emptiness as an answer rather than an error", async () => {
    const fixture = await createCompany();
    const report = await run(fixture.companyId, "sales-register");
    expect(report.empty).toBe(true);
  }, 90_000);
});

describe("what a report refuses to do", () => {
  it("refuses a key it does not know", async () => {
    const fixture = await createCompany();
    await expect(run(fixture.companyId, "../../etc/passwd")).rejects.toThrow(
      ReportError,
    );
  }, 90_000);

  it("refuses a range that runs backwards", async () => {
    const fixture = await createCompany();
    await expect(
      runReport({
        companyId: fixture.companyId,
        key: "trial-balance",
        period: { from: today, to: YEAR_START },
      }),
    ).rejects.toThrow(/after the end date/i);
  }, 90_000);

  it("refuses a range report with no range", async () => {
    const fixture = await createCompany();
    await expect(
      runReport({
        companyId: fixture.companyId,
        key: "sales-register",
        period: {},
      }),
    ).rejects.toThrow(/needs a date range/i);
  }, 90_000);

  it("never shows one company another company's figures", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany(),
      tradingCompany(),
    ]);

    // Mine has opening stock and nothing else; theirs has traded.
    const [ours, sales, stock, mineOwnStock, theirStock] = await Promise.all([
      run(mine.companyId, "trial-balance"),
      run(mine.companyId, "sales-register"),
      run(mine.companyId, "stock-on-hand"),
      stockRows(mine.companyId),
      stockRows(theirs.companyId),
    ]);

    expect(sales.empty).toBe(true);

    // My stock report is my stock, to the paisa — not theirs, and not the two
    // of them added together.
    const mineValue = mineOwnStock.reduce(
      (sum, entry) => add(sum, entry.stockValue),
      money(0),
    );
    const theirValue = theirStock.reduce(
      (sum, entry) => add(sum, entry.stockValue),
      money(0),
    );
    expect(stock.rows.at(-1)!.cells.value).toBe(toStorageString(mineValue));
    expect(toStorageString(mineValue)).not.toBe(toStorageString(theirValue));

    const theirTrial = await getTrialBalance({
      companyId: theirs.companyId,
      from: YEAR_START,
      to: today,
    });
    // The totals cannot coincide: theirs carries a sale, a bill and an expense.
    expect(ours.rows.at(-1)!.cells.debit).not.toBe(theirTrial.totalDebit);
  }, 120_000);
});
