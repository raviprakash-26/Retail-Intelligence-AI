import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JournalStatus, VoucherType } from "@prisma/client";
import type { RegisterInput } from "@/lib/validation/auth";
import type { CustomerInput, ProductInput } from "@/lib/validation/master-data";
import type { SaleInput } from "@/lib/validation/sales";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { registerOwner } from "@/server/auth/registration";
import { provisionCompany } from "@/server/provisioning/company-provisioner";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale } from "@/server/sales/sale-service";
import { closePeriod, listPeriods } from "@/server/accounting/period-service";
import {
  closeFiscalYear,
  listYearsForClosing,
  reopenFiscalYear,
  YearCloseError,
} from "@/server/accounting/year-close-service";
import { getFinancialStatements } from "@/server/accounting/statements-service";
import { getTrialBalance } from "@/server/accounting/trial-balance-service";
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
 * Closing the year.
 *
 * Closing a month freezes it. Closing a year settles what was earned: income
 * and expense accounts measure one year and one year only, so at the end of it
 * their balances move to retained earnings and they start the next year at nil.
 * Nothing wrote that entry, and everything needed for it was already here —
 * `RETAINED_EARNINGS` in every chart with nothing posted to it,
 * `VoucherType.CLOSING_ENTRY` in the schema with the auditor and the income-tax
 * computation already excluding it, and `FiscalYear.closedAt` read by the year
 * selector and written by nobody.
 *
 * What these cases hold to is the arithmetic. A closing entry that balances is
 * not enough: it has to leave the trial balance balanced, leave the balance
 * sheet's equity total exactly where it was, and leave the income accounts at
 * nil — which is the difference between transferring the year's result and
 * inventing it twice.
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
      businessName: `Close ${uniqueSlug("Mart")}`,
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

type Shop = {
  companyId: string;
  userId: string;
  yearId: string;
  from: Date;
  to: Date;
};

/** A shop that has sold something, with every month of its year closed. */
async function shopReadyToClose(options?: { sell?: boolean }): Promise<Shop> {
  const email = `yc-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const owner = await registerOwner(registrationInput(email));
  createdCompanies.push(owner.companyId);

  const base = {
    companyId: owner.companyId,
    userId: owner.userId,
    actorEmail: "owner@example.com",
  };

  if (options?.sell !== false) {
    const taxonomy = await getProductTaxonomy(owner.companyId);
    const unit = taxonomy.units.find((entry) => entry.code === "PCS")!;

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
        taxRateId: "",
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

    await createSale({
      ...base,
      branchId: null,
      input: {
        customerId: customer.id,
        invoiceDate: new Date().toISOString().slice(0, 10),
        paymentMode: "CASH",
        placeOfSupply: "",
        priceIncludesTax: false,
        notes: "",
        lines: [
          {
            productId: product.id,
            description: "",
            quantity: 20,
            rate: 250,
            discountPercent: 0,
          },
        ],
      } satisfies SaleInput,
    });
  }

  const year = (await resolveFiscalYear(owner.companyId))!;

  return {
    companyId: owner.companyId,
    userId: owner.userId,
    yearId: year.id,
    from: year.startDate,
    to: year.endDate,
  };
}

/** Closes every month of the shop's year, in order, the way a person would. */
async function closeEveryMonth(shop: Shop): Promise<void> {
  const periods = (await listPeriods(shop.companyId))
    .filter((period) => period.status === "OPEN")
    .sort((a, b) => a.startDate.getTime() - b.startDate.getTime());

  for (const period of periods) {
    await closePeriod({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      periodId: period.id,
    });
  }
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

beforeAll(async () => {
  await ensurePlatformData();
}, 60_000);

afterAll(async () => {
  for (const id of createdCompanies) await purgeTestCompany(id);
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

describe("closing a financial year", () => {
  it("moves the year's result to retained earnings and leaves nothing behind", async () => {
    const shop = await shopReadyToClose();

    const before = await getFinancialStatements({
      companyId: shop.companyId,
      from: isoDay(shop.from),
      to: isoDay(shop.to),
    });
    const profit = before.profitAndLoss.netProfit;
    expect(Number(profit)).toBeGreaterThan(0);

    await closeEveryMonth(shop);
    await closeFiscalYear({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      fiscalYearId: shop.yearId,
    });

    const after = await getFinancialStatements({
      companyId: shop.companyId,
      from: isoDay(shop.from),
      to: isoDay(shop.to),
    });

    // Income and expenses are back to nil: the year has been settled.
    expect(Number(after.trading.revenueTotal)).toBe(0);
    expect(Number(after.profitAndLoss.expensesTotal)).toBe(0);
    expect(Number(after.balanceSheet.earningsToDate)).toBe(0);

    // And retained earnings now carries exactly what was earned.
    const retained = await prisma.account.findFirstOrThrow({
      where: {
        companyId: shop.companyId,
        systemKey: SYSTEM_ACCOUNT.RETAINED_EARNINGS,
      },
      select: { id: true },
    });
    const lines = await prisma.journalLine.groupBy({
      by: ["accountId"],
      where: {
        companyId: shop.companyId,
        accountId: retained.id,
        status: JournalStatus.POSTED,
      },
      _sum: { debit: true, credit: true },
    });
    const net =
      Number(lines[0]?._sum.credit ?? 0) - Number(lines[0]?._sum.debit ?? 0);
    expect(net).toBeCloseTo(Number(profit), 2);
  }, 120_000);

  it("leaves the books balanced and equity unmoved", async () => {
    // The point of the whole exercise. Closing rearranges where the year's
    // result sits; it must not change what the business is worth.
    const shop = await shopReadyToClose();

    const before = await getFinancialStatements({
      companyId: shop.companyId,
      from: isoDay(shop.from),
      to: isoDay(shop.to),
    });

    await closeEveryMonth(shop);
    await closeFiscalYear({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      fiscalYearId: shop.yearId,
    });

    const after = await getFinancialStatements({
      companyId: shop.companyId,
      from: isoDay(shop.from),
      to: isoDay(shop.to),
    });
    const trial = await getTrialBalance({
      companyId: shop.companyId,
      to: isoDay(shop.to),
    });

    expect(after.balanceSheet.equityTotal).toBe(
      before.balanceSheet.equityTotal,
    );
    expect(after.balanceSheet.assetsTotal).toBe(
      before.balanceSheet.assetsTotal,
    );
    expect(after.balanceSheet.balanced).toBe(true);
    expect(trial.balanced).toBe(true);
  }, 120_000);

  it("writes one closing entry, and the year wears the padlock", async () => {
    const shop = await shopReadyToClose();
    await closeEveryMonth(shop);
    await closeFiscalYear({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      fiscalYearId: shop.yearId,
    });

    const entries = await prisma.journalEntry.findMany({
      where: {
        companyId: shop.companyId,
        voucherType: VoucherType.CLOSING_ENTRY,
        status: JournalStatus.POSTED,
      },
      select: { entryDate: true, isSystem: true },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.isSystem).toBe(true);
    // Dated the last day of the year it closes, not the day somebody pressed
    // the button.
    expect(isoDay(entries[0]!.entryDate)).toBe(isoDay(shop.to));

    const [view] = await listYearsForClosing(shop.companyId);
    expect(view!.closedAt).not.toBeNull();
    expect(view!.closingEntry).not.toBeNull();
  }, 120_000);

  it("refuses while a month of it is still open", async () => {
    const shop = await shopReadyToClose();

    // Every month but the last.
    const periods = (await listPeriods(shop.companyId))
      .filter((period) => period.status === "OPEN")
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
    for (const period of periods.slice(0, -1)) {
      await closePeriod({
        companyId: shop.companyId,
        userId: shop.userId,
        actorEmail: "owner@example.com",
        periodId: period.id,
      });
    }

    await expect(
      closeFiscalYear({
        companyId: shop.companyId,
        userId: shop.userId,
        actorEmail: "owner@example.com",
        fiscalYearId: shop.yearId,
      }),
    ).rejects.toThrow(/still open/i);

    const [view] = await listYearsForClosing(shop.companyId);
    expect(view!.closable).toBe(false);
    expect(view!.openPeriods).toHaveLength(1);
  }, 120_000);

  it("refuses to close twice", async () => {
    const shop = await shopReadyToClose();
    await closeEveryMonth(shop);

    const close = () =>
      closeFiscalYear({
        companyId: shop.companyId,
        userId: shop.userId,
        actorEmail: "owner@example.com",
        fiscalYearId: shop.yearId,
      });

    await close();
    await expect(close()).rejects.toBeInstanceOf(YearCloseError);
    await expect(close()).rejects.toThrow(/already closed/i);
  }, 120_000);

  it("writes no entry for a year in which nothing was earned", async () => {
    // A shop that registered and never traded. An empty closing entry would be
    // noise in a journal that is read by people.
    const shop = await shopReadyToClose({ sell: false });
    await closeEveryMonth(shop);
    await closeFiscalYear({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      fiscalYearId: shop.yearId,
    });

    const entries = await prisma.journalEntry.count({
      where: {
        companyId: shop.companyId,
        voucherType: VoucherType.CLOSING_ENTRY,
      },
    });
    expect(entries).toBe(0);

    const [view] = await listYearsForClosing(shop.companyId);
    expect(view!.closedAt).not.toBeNull();
  }, 120_000);
});

describe("two years, closed in order", () => {
  /**
   * A shop that has traded through a year boundary, with every month shut.
   *
   * Periods already close in order across years, so reaching a state where the
   * later year's months are all closed means the earlier year's are too — and
   * the earlier *year* can still be open, which is exactly the case the
   * ordering guard is for.
   */
  async function twoYearShop() {
    const email = `yc2-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
    createdEmails.push(email);
    const owner = await registerOwner(registrationInput(email));
    createdCompanies.push(owner.companyId);

    const now = new Date();
    const provisioned = await prisma.$transaction((tx) =>
      provisionCompany(tx, {
        name: "Two Year Close Mart",
        slug: uniqueSlug("twoyearclose"),
        stateCode: "29",
        fiscalYearStartMonth: 4,
        asOf: new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 15),
        ),
      }),
    );
    createdCompanies.push(provisioned.companyId);

    const cash = provisioned.accountsBySystemKey.get(SYSTEM_ACCOUNT.CASH)!;
    const sales = provisioned.accountsBySystemKey.get(SYSTEM_ACCOUNT.SALES)!;
    const first = await prisma.fiscalYear.findFirstOrThrow({
      where: { companyId: provisioned.companyId },
      select: { id: true, startDate: true, endDate: true },
    });

    // Something earned in each year, so both closing entries have work to do.
    for (const on of [
      new Date(first.startDate.getTime() + 40 * 86_400_000),
      now,
    ]) {
      await prisma.$transaction((tx) =>
        postJournalEntry(tx, {
          companyId: provisioned.companyId,
          entryDate: on,
          voucherType: VoucherType.JOURNAL,
          createdById: owner.userId,
          narration: "Counter sale",
          lines: [
            { accountId: cash, debit: 1000 },
            { accountId: sales, credit: 1000 },
          ],
        }),
      );
    }

    const years = await prisma.fiscalYear.findMany({
      where: { companyId: provisioned.companyId },
      select: { id: true, label: true },
      orderBy: { startDate: "asc" },
    });
    expect(years).toHaveLength(2);

    const shop: Shop = {
      companyId: provisioned.companyId,
      userId: owner.userId,
      yearId: years[0]!.id,
      from: first.startDate,
      to: first.endDate,
    };
    await closeEveryMonth(shop);

    return { shop, earlier: years[0]!, later: years[1]! };
  }

  it("refuses to close the later year while the earlier one is open", async () => {
    const { shop, earlier, later } = await twoYearShop();

    await expect(
      closeFiscalYear({
        companyId: shop.companyId,
        userId: shop.userId,
        actorEmail: "owner@example.com",
        fiscalYearId: later.id,
      }),
    ).rejects.toThrow(/comes first/i);

    // Closing out of order would have swept the earlier year's earnings into
    // this one, because the entry clears whatever is sitting in the income
    // accounts on the closing date.
    const closed = await prisma.fiscalYear.count({
      where: { companyId: shop.companyId, closedAt: { not: null } },
    });
    expect(closed).toBe(0);

    const view = (await listYearsForClosing(shop.companyId)).find(
      (year) => year.id === later.id,
    );
    expect(view!.closable).toBe(false);
    expect(view!.openPeriods).toHaveLength(0);

    // And in order, both close.
    await closeFiscalYear({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      fiscalYearId: earlier.id,
    });
    await closeFiscalYear({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      fiscalYearId: later.id,
    });

    const entries = await prisma.journalEntry.findMany({
      where: {
        companyId: shop.companyId,
        voucherType: VoucherType.CLOSING_ENTRY,
        status: JournalStatus.POSTED,
      },
      select: { fiscalYearId: true, totalDebit: true },
    });
    expect(entries).toHaveLength(2);
    // Each year settled its own thousand, rather than one entry taking both.
    for (const entry of entries) {
      expect(Number(entry.totalDebit)).toBe(1000);
    }
  }, 180_000);
});

describe("reopening a closed year", () => {
  it("puts the year's earnings back where they were", async () => {
    const shop = await shopReadyToClose();

    const before = await getFinancialStatements({
      companyId: shop.companyId,
      from: isoDay(shop.from),
      to: isoDay(shop.to),
    });

    await closeEveryMonth(shop);
    await closeFiscalYear({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      fiscalYearId: shop.yearId,
    });
    await reopenFiscalYear({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      fiscalYearId: shop.yearId,
      reason: "An invoice was missed from March",
    });

    const after = await getFinancialStatements({
      companyId: shop.companyId,
      from: isoDay(shop.from),
      to: isoDay(shop.to),
    });

    expect(after.trading.revenueTotal).toBe(before.trading.revenueTotal);
    expect(after.profitAndLoss.netProfit).toBe(before.profitAndLoss.netProfit);
    expect(after.balanceSheet.equityTotal).toBe(
      before.balanceSheet.equityTotal,
    );
    expect(after.balanceSheet.balanced).toBe(true);

    const [view] = await listYearsForClosing(shop.companyId);
    expect(view!.closedAt).toBeNull();
  }, 120_000);

  it("reverses rather than deletes, and records why", async () => {
    const shop = await shopReadyToClose();
    await closeEveryMonth(shop);
    await closeFiscalYear({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      fiscalYearId: shop.yearId,
    });
    await reopenFiscalYear({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      fiscalYearId: shop.yearId,
      reason: "March invoice was missed",
    });

    // Both entries stay: the books show the year was closed and then opened,
    // rather than showing that it never happened.
    const entries = await prisma.journalEntry.findMany({
      where: {
        companyId: shop.companyId,
        voucherType: VoucherType.CLOSING_ENTRY,
      },
      select: { reversesId: true },
    });
    expect(entries).toHaveLength(2);
    expect(entries.filter((entry) => entry.reversesId !== null)).toHaveLength(
      1,
    );

    const log = await prisma.auditLog.findFirst({
      where: { companyId: shop.companyId, action: "fiscalYear.reopened" },
      select: { metadata: true },
    });
    expect(JSON.stringify(log?.metadata)).toContain("March invoice was missed");
  }, 120_000);

  it("refuses to reopen a year that is not closed", async () => {
    const shop = await shopReadyToClose({ sell: false });

    await expect(
      reopenFiscalYear({
        companyId: shop.companyId,
        userId: shop.userId,
        actorEmail: "owner@example.com",
        fiscalYearId: shop.yearId,
        reason: "No reason it should work",
      }),
    ).rejects.toThrow(/not closed/i);
  }, 120_000);
});
