import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegisterInput } from "@/lib/validation/auth";
import type {
  CustomerInput,
  ProductInput,
  SupplierInput,
} from "@/lib/validation/master-data";
import type { SaleInput } from "@/lib/validation/sales";
import type { PurchaseInput } from "@/lib/validation/purchases";
import type { ExpenseInput } from "@/lib/validation/expenses";
import { VoucherType } from "@prisma/client";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { registerOwner } from "@/server/auth/registration";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import { provisionCompany } from "@/server/provisioning/company-provisioner";
import { ensureFiscalYearFor } from "@/server/fiscal/fiscal-calendar";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale } from "@/server/sales/sale-service";
import { createPurchase } from "@/server/purchases/purchase-service";
import { createExpense } from "@/server/expenses/expense-service";
import { getDashboardOverview } from "@/server/dashboard/overview";
import { getFinancialStatements } from "@/server/accounting/statements-service";
import { getStockSummary } from "@/server/inventory/inventory-report";
import {
  payablesAgeing,
  receivablesAgeing,
} from "@/server/settlements/outstanding";
// The page reads the header's cookie; a test has no header, so it resolves
// the year the same way the helper does once it has an id.
import { resolveFiscalYear } from "@/server/fiscal/fiscal-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * The front page, and whether it agrees with the pages behind it.
 *
 * Eight of the dashboard's twelve tiles were placeholders naming the module
 * they waited for — "Arrives with the Sales module", "Arrives with the
 * Inventory module" — long after every one of those modules had shipped. A shop
 * trading for months opened the product to a page saying most of its numbers
 * were not built yet, with the figures sitting one click away.
 *
 * Filling them in is only half the job. The half that matters afterwards is
 * that the dashboard never becomes a second opinion: each figure has to be the
 * one the module that owns it would give, because the screen everybody opens
 * first is where a disagreement gets noticed and where it is least explicable.
 */

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
      businessName: `Overview ${uniqueSlug("Mart")}`,
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
      openingBankBalance: 25000,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

type Shop = { companyId: string; userId: string; from: Date; to: Date };

/** A shop that has bought, sold on credit, and paid for something. */
async function tradingShop(): Promise<Shop> {
  const email = `dash-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const owner = await registerOwner(registrationInput(email));
  createdCompanies.push(owner.companyId);

  const base = {
    companyId: owner.companyId,
    userId: owner.userId,
    actorEmail: "owner@example.com",
  };

  const taxonomy = await getProductTaxonomy(owner.companyId);
  const unit = taxonomy.units.find((entry) => entry.code === "PCS");
  // Taxed, so that output tax and input credit both move and the GST tile has
  // something to report rather than a structural nil.
  const taxRate = taxonomy.taxRates.find(
    (rate) => Number(rate.ratePercent) === 18,
  );
  if (!unit || !taxRate) throw new Error("Provisioning is incomplete");

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
      taxRateId: taxRate.id,
      purchasePrice: 60,
      sellingPrice: 250,
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
      name: "Karnataka Wholesale",
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

  const today = new Date().toISOString().slice(0, 10);

  await createPurchase({
    ...base,
    branchId: null,
    input: {
      supplierId: supplier.id,
      supplierBillNo: "KW-1001",
      billDate: today,
      paymentMode: "CREDIT",
      priceIncludesTax: false,
      claimInputCredit: true,
      notes: "",
      lines: [
        {
          productId: product.id,
          description: "",
          quantity: 40,
          rate: 60,
          discountPercent: 0,
        },
      ],
    } satisfies PurchaseInput,
  });

  await createSale({
    ...base,
    branchId: null,
    input: {
      customerId: customer.id,
      invoiceDate: today,
      paymentMode: "CREDIT",
      placeOfSupply: "",
      priceIncludesTax: false,
      notes: "",
      lines: [
        {
          productId: product.id,
          description: "",
          quantity: 25,
          rate: 250,
          discountPercent: 0,
        },
      ],
    } satisfies SaleInput,
  });

  const categories = await prisma.expenseCategory.findMany({
    where: { companyId: owner.companyId },
    select: { id: true },
    take: 1,
  });

  await createExpense({
    ...base,
    branchId: null,
    input: {
      categoryId: categories[0]!.id,
      expenseDate: today,
      amount: 4500,
      paymentMode: "CASH",
      supplierId: "",
      payeeName: "Landlord",
      taxPercent: 0,
      amountIncludesTax: true,
      claimInputCredit: false,
      isCapitalExpenditure: false,
      assetName: "",
      assetUsefulLifeMonths: 60,
      referenceNo: "",
      notes: "Shop rent",
    } satisfies ExpenseInput,
  });

  const year = await resolveFiscalYear(owner.companyId);
  if (!year) throw new Error("A provisioned company has a fiscal year");

  return {
    companyId: owner.companyId,
    userId: owner.userId,
    from: year.startDate,
    to: year.endDate,
  };
}

beforeAll(async () => {
  await ensurePlatformData();
}, 60_000);

afterAll(async () => {
  for (const id of createdCompanies) await purgeTestCompany(id);
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

describe("the figures on the front page", () => {
  it("agree with the reports they came from", async () => {
    const shop = await tradingShop();

    const [overview, statements, receivable, payable, stock] =
      await Promise.all([
        getDashboardOverview(shop),
        getFinancialStatements({
          companyId: shop.companyId,
          from: shop.from.toISOString().slice(0, 10),
          to: shop.to.toISOString().slice(0, 10),
        }),
        receivablesAgeing(shop.companyId),
        payablesAgeing(shop.companyId),
        getStockSummary({ companyId: shop.companyId }),
      ]);

    // Not "close to" and not "recomputed the same way" — the identical string,
    // because the dashboard reads the figure rather than working it out again.
    expect(overview.trading?.revenue).toBe(statements.trading.revenueTotal);
    expect(overview.trading?.costOfSales).toBe(
      statements.trading.costOfSalesTotal,
    );
    expect(overview.trading?.grossProfit).toBe(statements.trading.grossProfit);
    expect(overview.trading?.expenses).toBe(
      statements.profitAndLoss.expensesTotal,
    );
    expect(overview.trading?.netProfit).toBe(
      statements.profitAndLoss.netProfit,
    );

    expect(overview.receivables).toBe(receivable.summary.total);
    expect(overview.receivablesOverdue).toBe(receivable.summary.overdue);
    expect(overview.payables).toBe(payable.summary.total);
    expect(overview.payablesOverdue).toBe(payable.summary.overdue);
    expect(overview.inventoryValue).toBe(stock.totalValue);
  }, 120_000);

  it("has something to show for a shop that has traded", async () => {
    // The state this replaced: eight tiles rendering a skeleton and a note
    // about a module that shipped long ago. A test that only checked the
    // figures matched would still pass if every one of them were nil.
    const shop = await tradingShop();
    const overview = await getDashboardOverview(shop);

    expect(Number(overview.cash)).toBeGreaterThan(0);
    expect(Number(overview.bank)).toBeGreaterThan(0);
    expect(Number(overview.trading?.revenue)).toBeGreaterThan(0);
    expect(Number(overview.trading?.purchases)).toBeGreaterThan(0);
    expect(Number(overview.trading?.expenses)).toBeGreaterThan(0);
    expect(Number(overview.trading?.grossProfit)).toBeGreaterThan(0);
    expect(Number(overview.receivables)).toBeGreaterThan(0);
    expect(Number(overview.payables)).toBeGreaterThan(0);
    expect(Number(overview.inventoryValue)).toBeGreaterThan(0);
    expect(Number(overview.gstOnTheBooks)).not.toBe(0);
    expect(overview.books.balanced).toBe(true);
    expect(overview.empty).toBe(false);
  }, 120_000);

  it("reports purchases from the bills, not from the trading account", async () => {
    // Stock is held at cost under perpetual inventory, so a bill debits stock
    // rather than a Purchases account. Reading purchases off the profit and
    // loss account would print zero forever.
    const shop = await tradingShop();
    const overview = await getDashboardOverview(shop);

    const bills = await prisma.purchase.aggregate({
      where: { companyId: shop.companyId, status: "POSTED" },
      _sum: { totalAmount: true },
    });

    expect(overview.trading?.purchases).toBe(
      bills._sum.totalAmount?.toFixed(4),
    );
    expect(overview.trading?.purchases).not.toBe(overview.trading?.costOfSales);
  }, 120_000);

  it("carries a position forward into the next year", async () => {
    // Cash in hand is a position, not a period movement. The dashboard used to
    // sum journal lines *within* the selected year, which is the same number
    // while a tenant has only ever had one year and wrong the moment it has
    // two: the cash a shop opened April with would vanish from its own front
    // page on the first of April.
    const email = `dash-carry-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
    createdEmails.push(email);
    const owner = await registerOwner(registrationInput(email));
    createdCompanies.push(owner.companyId);

    const now = new Date();
    const provisioned = await prisma.$transaction((tx) =>
      provisionCompany(tx, {
        name: "Carried Forward Mart",
        slug: uniqueSlug("carried"),
        stateCode: "29",
        fiscalYearStartMonth: 4,
        asOf: new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 15),
        ),
      }),
    );
    createdCompanies.push(provisioned.companyId);

    const cashId = provisioned.accountsBySystemKey.get(SYSTEM_ACCOUNT.CASH)!;
    const capitalId = provisioned.accountsBySystemKey.get(
      SYSTEM_ACCOUNT.OWNER_CAPITAL,
    )!;
    const firstYear = await prisma.fiscalYear.findFirstOrThrow({
      where: { companyId: provisioned.companyId },
      select: { startDate: true },
    });

    // Money put in during the first year, and nothing at all in the second.
    await prisma.$transaction((tx) =>
      postJournalEntry(tx, {
        companyId: provisioned.companyId,
        entryDate: firstYear.startDate,
        voucherType: VoucherType.OPENING_BALANCE,
        isSystem: true,
        createdById: owner.userId,
        lines: [
          { accountId: cashId, debit: 75000 },
          { accountId: capitalId, credit: 75000 },
        ],
      }),
    );

    // Opening the second year the way trading does.
    await prisma.$transaction((tx) =>
      ensureFiscalYearFor(tx, { companyId: provisioned.companyId, date: now }),
    );
    const secondYear = await prisma.fiscalYear.findFirstOrThrow({
      where: { companyId: provisioned.companyId, isCurrent: true },
      select: { startDate: true, endDate: true },
    });

    const overview = await getDashboardOverview({
      companyId: provisioned.companyId,
      from: secondYear.startDate,
      to: secondYear.endDate,
    });

    // The position stands at what was carried in; the year's trading is nil,
    // and those are different statements.
    expect(Number(overview.cash)).toBe(75000);
    expect(Number(overview.trading?.revenue)).toBe(0);
  }, 90_000);

  it("reports a true zero for a shop that has not traded", async () => {
    // A freshly registered shop has its opening balances and nothing else.
    // Zero sales is a true statement about it — which is the whole reason the
    // pending state exists elsewhere, to keep "nothing sold" distinguishable
    // from "cannot say".
    const email = `dash-new-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
    createdEmails.push(email);
    const owner = await registerOwner(registrationInput(email));
    createdCompanies.push(owner.companyId);

    const year = await resolveFiscalYear(owner.companyId);
    const overview = await getDashboardOverview({
      companyId: owner.companyId,
      from: year!.startDate,
      to: year!.endDate,
    });

    expect(Number(overview.trading?.revenue)).toBe(0);
    expect(Number(overview.receivables)).toBe(0);
    expect(Number(overview.cash)).toBe(50000);
    expect(overview.books.balanced).toBe(true);
  }, 90_000);
});
