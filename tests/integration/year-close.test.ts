import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JournalStatus, VoucherType } from "@prisma/client";
import type { RegisterInput } from "@/lib/validation/auth";
import type { CustomerInput, ProductInput } from "@/lib/validation/master-data";
import type { SaleInput } from "@/lib/validation/sales";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { registerOwner } from "@/server/auth/registration";
import { provisionCompany } from "@/server/provisioning/company-provisioner";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import {
  assignableGroups,
  createAccount,
  setAccountActive,
} from "@/server/accounting/account-service";
import { accountBalances } from "@/server/accounting/balances";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale } from "@/server/sales/sale-service";
import {
  closePeriod,
  listPeriods,
  PeriodError,
  reopenPeriod,
} from "@/server/accounting/period-service";
import {
  closeFiscalYear,
  listYearsForClosing,
  reopenFiscalYear,
  YearCloseError,
} from "@/server/accounting/year-close-service";
import { getFinancialStatements } from "@/server/accounting/statements-service";
import { getTrialBalance } from "@/server/accounting/trial-balance-service";
import { getCashProjection } from "@/server/forecast/cash-projection";
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

/** One of the accounts every chart is provisioned with, by its key. */
async function systemAccount(
  companyId: string,
  systemKey: string,
): Promise<string> {
  const account = await prisma.account.findFirstOrThrow({
    where: { companyId, systemKey },
    select: { id: true },
  });
  return account.id;
}

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

    // The year's own profit and loss account still reports the year. Closing
    // settles where the result sits; it does not unmake the trading, and the
    // income tax working paper is built on this figure — a return is filed
    // after the year end, which is to say after the close.
    expect(Number(after.trading.revenueTotal)).toBe(
      Number(before.trading.revenueTotal),
    );
    expect(Number(after.profitAndLoss.netProfit)).toBe(Number(profit));

    // What the close moves is the balance sheet: nothing is left sitting in
    // the income accounts to be counted as equity, because retained earnings
    // now carries it.
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

  /**
   * The year's own tax computation has to survive its close.
   *
   * A return is filed after the year end, which is to say after the year has
   * been closed — the two acts are days apart and in that order. The working
   * paper is built on the book profit the statements engine reports, so when
   * closing emptied the profit and loss account it emptied the computation
   * with it: nil turnover, nil book profit, nil taxable income, for a year the
   * shop had traded through and owed tax on.
   */
  it("leaves the year's tax computation intact", async () => {
    const shop = await shopReadyToClose();
    const { getTaxWorkingPaper } =
      await import("@/server/tax/income-tax-service");

    const before = await getTaxWorkingPaper({
      companyId: shop.companyId,
      fiscalYearId: shop.yearId,
    });
    expect(Number(before?.turnover)).toBeGreaterThan(0);
    expect(Number(before?.bookNetProfit)).toBeGreaterThan(0);

    await closeEveryMonth(shop);
    await closeFiscalYear({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      fiscalYearId: shop.yearId,
    });

    const after = await getTaxWorkingPaper({
      companyId: shop.companyId,
      fiscalYearId: shop.yearId,
    });
    expect(Number(after?.turnover)).toBe(Number(before?.turnover));
    expect(Number(after?.bookNetProfit)).toBe(Number(before?.bookNetProfit));
    expect(Number(after?.taxableIncome)).toBe(Number(before?.taxableIncome));
  }, 120_000);

  /**
   * The add-back has to survive it too, and it was not covered by the case
   * above.
   *
   * Turnover and book profit come from the statements engine, which excludes
   * closing entries from the movement it reports. The depreciation add-back
   * does not: it is summed from `accountBalances` over the year, and that call
   * was left as it was. A shop with no depreciation in its books cannot tell
   * the difference, which is why the case above passed while this one did not.
   *
   * What it costs is a deduction taken twice. Book profit is already net of the
   * depreciation charged, so the charge is added back and the Act's own figure
   * — written down value, Appendix I rates — is deducted in its place. When the
   * add-back reads nil the charge stays in profit *and* the Act's figure comes
   * off as well. The taxable income is understated by the whole of the year's
   * book depreciation, and the working paper shows "Add: depreciation charged
   * in the books — 0.00" beside a profit and loss account that plainly shows
   * the charge.
   */
  it("still adds back the depreciation charged in the books", async () => {
    const shop = await shopReadyToClose();
    const { getTaxWorkingPaper } =
      await import("@/server/tax/income-tax-service");

    // Depreciation the way a shop actually charges it: a manual journal at the
    // year end, expense debited, accumulated depreciation credited. Nothing in
    // this product posts one for you.
    const [expense, accumulated] = await Promise.all([
      systemAccount(shop.companyId, SYSTEM_ACCOUNT.DEPRECIATION_EXPENSE),
      systemAccount(shop.companyId, SYSTEM_ACCOUNT.ACCUMULATED_DEPRECIATION),
    ]);
    await prisma.$transaction((tx) =>
      postJournalEntry(tx, {
        companyId: shop.companyId,
        entryDate: new Date(),
        voucherType: VoucherType.JOURNAL,
        createdById: shop.userId,
        narration: "Depreciation for the year",
        lines: [
          { accountId: expense, debit: 12_000 },
          { accountId: accumulated, credit: 12_000 },
        ],
      }),
    );

    const before = await getTaxWorkingPaper({
      companyId: shop.companyId,
      fiscalYearId: shop.yearId,
    });
    expect(Number(before?.bookDepreciation)).toBe(12_000);

    await closeEveryMonth(shop);
    await closeFiscalYear({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      fiscalYearId: shop.yearId,
    });

    const after = await getTaxWorkingPaper({
      companyId: shop.companyId,
      fiscalYearId: shop.yearId,
    });

    expect(Number(after?.bookDepreciation)).toBe(12_000);
    // The line the reader sees, and the total it feeds.
    const addBack = after?.computation.find((line) =>
      line.label.startsWith("Add: depreciation"),
    );
    expect(addBack).toBeDefined();
    expect(Number(addBack?.amount)).toBe(12_000);
    expect(Number(after?.taxableIncome)).toBe(Number(before?.taxableIncome));
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

  /**
   * The same ordering rule, approached from the other end.
   *
   * Closing refuses to shut a year while an earlier one is open, and says why:
   * the entry clears whatever is sitting in the income accounts on the closing
   * date, so closing out of order sweeps the earlier year's earnings into the
   * later one. `postClosingEntry` leans on that guarantee in so many words —
   * earlier years are already closed, so nothing older is left in there.
   *
   * Reopening never learned the rule. It checks that the year exists and is
   * closed, and nothing else, so the state the close path refuses to create
   * can be reached by reopening an earlier year underneath a closed one. The
   * later year is then settled by an entry that no longer settles anything:
   * its income accounts hold the reopened year's figures again, and every
   * cumulative read past it carries them.
   *
   * This is the year-level twin of the month-level gap below, where
   * `reopenPeriod` was written before anything could close a year and never
   * learned about it either.
   */
  async function bothYearsClosed() {
    const { shop, earlier, later } = await twoYearShop();
    for (const year of [earlier, later]) {
      await closeFiscalYear({
        companyId: shop.companyId,
        userId: shop.userId,
        actorEmail: "owner@example.com",
        fiscalYearId: year.id,
      });
    }
    return { shop, earlier, later };
  }

  it("refuses to reopen the earlier year while the later one is closed", async () => {
    const { shop, earlier, later } = await bothYearsClosed();

    await expect(
      reopenFiscalYear({
        companyId: shop.companyId,
        userId: shop.userId,
        actorEmail: "owner@example.com",
        fiscalYearId: earlier.id,
        reason: "Correcting a supplier bill",
      }),
    ).rejects.toThrow(/comes after|reopen .*first/i);

    // And nothing moved: a refusal that had already reversed the entry would
    // be worse than no guard at all.
    const stillClosed = await prisma.fiscalYear.count({
      where: { companyId: shop.companyId, closedAt: { not: null } },
    });
    expect(stillClosed).toBe(2);
    expect(later.id).not.toBe(earlier.id);
  }, 180_000);

  it("leaves the later year's books settled", async () => {
    // The consequence in figures. A closed year's income accounts read nil at
    // its own year end — that is what closing means — and reopening the year
    // underneath it puts a thousand back into them.
    const { shop, earlier, later } = await bothYearsClosed();

    await reopenFiscalYear({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      fiscalYearId: earlier.id,
      reason: "Correcting a supplier bill",
    }).catch(() => undefined);

    const laterYear = await prisma.fiscalYear.findFirstOrThrow({
      where: { id: later.id },
      select: { endDate: true, closedAt: true },
    });
    if (!laterYear.closedAt) return; // Reopened in order; nothing to check.

    const balances = await accountBalances({
      companyId: shop.companyId,
      to: laterYear.endDate,
    });
    const earned = balances.filter(
      (account) => account.type === "INCOME" || account.type === "EXPENSE",
    );
    for (const account of earned) {
      expect(
        Number(account.closingDebit) - Number(account.closingCredit),
        `${account.name} at the end of a closed year`,
      ).toBe(0);
    }
  }, 180_000);

  it("reopens them in order, the later year first", async () => {
    // The legitimate path has to stay open, or the guard has simply made a
    // closed year permanent.
    const { shop, earlier, later } = await bothYearsClosed();

    for (const year of [later, earlier]) {
      await reopenFiscalYear({
        companyId: shop.companyId,
        userId: shop.userId,
        actorEmail: "owner@example.com",
        fiscalYearId: year.id,
        reason: "Correcting a supplier bill",
      });
    }

    const open = await prisma.fiscalYear.count({
      where: { companyId: shop.companyId, closedAt: null },
    });
    expect(open).toBe(2);
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

/**
 * The months inside a year that has been closed.
 *
 * `reopenPeriod` was written before anything could close a year, and never
 * learned about it. It asked whether the *period* was closed and nothing else,
 * so a month inside a settled year could be reopened on its own and posted
 * into — after the closing entry that swept that month's income into retained
 * earnings had already been written. The year went on wearing its padlock
 * while its profit moved, and no route existed to sweep the difference: a
 * closed year is not closable again.
 *
 * These cases fix the boundary between the two modules, which is the thing
 * neither of them owned.
 */
describe("months inside a closed year", () => {
  /** A shop whose year is closed, and the month it traded in. */
  async function shopWithClosedYear() {
    const shop = await shopReadyToClose();
    await closeEveryMonth(shop);
    await closeFiscalYear({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      fiscalYearId: shop.yearId,
    });

    const now = Date.now();
    const trading = (await listPeriods(shop.companyId)).find(
      (period) =>
        period.startDate.getTime() <= now && period.endDate.getTime() >= now,
    )!;
    return { shop, trading };
  }

  it("refuses to reopen one, and names the year to reopen instead", async () => {
    const { shop, trading } = await shopWithClosedYear();

    await expect(
      reopenPeriod({
        companyId: shop.companyId,
        userId: shop.userId,
        actorEmail: "owner@example.com",
        periodId: trading.id,
        reason: "A supplier bill arrived late",
      }),
    ).rejects.toMatchObject({ code: "YEAR_CLOSED" });

    // Named, not merely refused: the person has to know the year comes first.
    await expect(
      reopenPeriod({
        companyId: shop.companyId,
        userId: shop.userId,
        actorEmail: "owner@example.com",
        periodId: trading.id,
        reason: "A supplier bill arrived late",
      }),
    ).rejects.toThrow(/reopen the year first/i);

    const after = (await listPeriods(shop.companyId)).find(
      (period) => period.id === trading.id,
    )!;
    expect(after.status).toBe("CLOSED");
  }, 120_000);

  it("keeps the settled year settled", async () => {
    // The defect this guards, stated as the shop would see it: a year that has
    // been closed reports a settled result, and must still report the same one
    // after somebody has tried to prise a month of it back open.
    const { shop, trading } = await shopWithClosedYear();

    const revenue = async () =>
      Number(
        (
          await getFinancialStatements({
            companyId: shop.companyId,
            from: isoDay(shop.from),
            to: isoDay(shop.to),
          })
        ).trading.revenueTotal,
      );

    const settled = await revenue();
    expect(settled).toBeGreaterThan(0);

    await expect(
      reopenPeriod({
        companyId: shop.companyId,
        userId: shop.userId,
        actorEmail: "owner@example.com",
        periodId: trading.id,
        reason: "A supplier bill arrived late",
      }),
    ).rejects.toThrow(PeriodError);

    // Nothing can be posted into it, so the year's result cannot drift away
    // from the retained earnings the closing entry already moved.
    expect(await revenue()).toBe(settled);
    const year = await prisma.fiscalYear.findUniqueOrThrow({
      where: { id: shop.yearId },
      select: { closedAt: true },
    });
    expect(year.closedAt).not.toBeNull();
  }, 120_000);

  it("reports the month as un-reopenable, so the screen can grey the button", async () => {
    const { shop, trading } = await shopWithClosedYear();

    const view = (await listPeriods(shop.companyId)).find(
      (period) => period.id === trading.id,
    )!;
    expect(view.status).toBe("CLOSED");
    expect(view.fiscalYearClosed).toBe(true);
    expect(view.reopenable).toBe(false);
  }, 120_000);

  it("lets the month reopen once the year has been reopened", async () => {
    // One extra step, not a different road — which is what makes the refusal
    // above a reasonable thing to do to somebody with a late supplier bill.
    const { shop, trading } = await shopWithClosedYear();

    await reopenFiscalYear({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      fiscalYearId: shop.yearId,
      reason: "A supplier bill arrived after the year was closed",
    });

    const between = (await listPeriods(shop.companyId)).find(
      (period) => period.id === trading.id,
    )!;
    // Reopening the year does not reopen its months; it makes them reopenable.
    expect(between.status).toBe("CLOSED");
    expect(between.reopenable).toBe(true);

    const reopened = await reopenPeriod({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      periodId: trading.id,
      reason: "A supplier bill arrived late",
    });
    expect(reopened.status).toBe("OPEN");
  }, 120_000);

  it("still reopens a month in a year that was never closed", async () => {
    // The ordinary case, which the new guard must not have caught up in it.
    const shop = await shopReadyToClose();
    await closeEveryMonth(shop);

    const now = Date.now();
    const trading = (await listPeriods(shop.companyId)).find(
      (period) =>
        period.startDate.getTime() <= now && period.endDate.getTime() >= now,
    )!;
    expect(trading.reopenable).toBe(true);

    const reopened = await reopenPeriod({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      periodId: trading.id,
      reason: "A supplier bill arrived late",
    });
    expect(reopened.status).toBe("OPEN");
  }, 120_000);
});

/**
 * An account retired between one close and the next.
 *
 * Closing the year brings every income and expense account to nil — that is what
 * it is for. Which makes the moment after a close exactly when somebody tidies
 * the chart and puts away the accounts they no longer use: they all read zero,
 * and retiring one is allowed precisely because it does.
 *
 * Then something turns up that means the year has to be reopened and closed
 * again, which the system supports and expects. The second closing entry was
 * built from the active accounts only, so whatever the retired one was carrying
 * at the year end was left out of the year's result — while the profit and loss
 * account, which reads inactive accounts too, went on showing it.
 *
 * That is two reports disagreeing about one year's profit, and the one that is
 * wrong is the one that gets posted. Retained earnings ends up crediting a
 * figure the statements never reported, the retired account keeps a balance no
 * close will ever clear, and the expense lands in whichever year it is finally
 * noticed in. The books balance throughout, so nothing complains.
 *
 * The guard on retiring an account is not what is at fault: it asks whether the
 * account is carrying anything *now*, which is the right question for putting an
 * account away. Closing asks what it was carrying *at the year end*. Two
 * different questions, and the close is the one that has to read every account.
 */
describe("an account retired between one close and the next", () => {
  async function shopWithARetirableExpense() {
    const shop = await shopReadyToClose();

    const groups = await assignableGroups({
      companyId: shop.companyId,
      type: "EXPENSE",
    });
    const group = groups.find((entry) => entry.code === "6100") ?? groups[0]!;

    const account = await createAccount({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      input: {
        // Clear of the standard chart, which grows as the product does.
        code: "6907",
        name: "Diwali promotion",
        groupId: group.id,
        type: "EXPENSE",
        subType: "INDIRECT_EXPENSE",
        description: "",
      },
    });

    const cash = await prisma.account.findFirstOrThrow({
      where: { companyId: shop.companyId, systemKey: SYSTEM_ACCOUNT.CASH },
      select: { id: true },
    });

    await prisma.$transaction((tx) =>
      postJournalEntry(tx, {
        companyId: shop.companyId,
        entryDate: new Date(),
        voucherType: VoucherType.JOURNAL,
        createdById: shop.userId,
        narration: "Lights and sweets for the festival window",
        lines: [
          { accountId: account.id, debit: 4000 },
          { accountId: cash.id, credit: 4000 },
        ],
      }),
    );

    return { shop, accountId: account.id };
  }

  const statementsFor = (shop: Shop) =>
    getFinancialStatements({
      companyId: shop.companyId,
      from: isoDay(shop.from),
      to: isoDay(shop.to),
    });

  const retainedEarningsMovement = async (companyId: string) => {
    const retained = await prisma.account.findFirstOrThrow({
      where: { companyId, systemKey: SYSTEM_ACCOUNT.RETAINED_EARNINGS },
      select: { id: true },
    });
    const lines = await prisma.journalLine.groupBy({
      by: ["accountId"],
      where: {
        companyId,
        accountId: retained.id,
        status: JournalStatus.POSTED,
      },
      _sum: { debit: true, credit: true },
    });
    return (
      Number(lines[0]?._sum.credit ?? 0) - Number(lines[0]?._sum.debit ?? 0)
    );
  };

  async function closeYear(shop: Shop) {
    await closeFiscalYear({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      fiscalYearId: shop.yearId,
    });
  }

  it("still counts what it was carrying when the year ended", async () => {
    const { shop, accountId } = await shopWithARetirableExpense();

    const profit = Number((await statementsFor(shop)).profitAndLoss.netProfit);

    await closeEveryMonth(shop);
    await closeYear(shop);

    // The close has zeroed it, so putting it away is allowed — and this is
    // exactly when somebody would.
    await setAccountActive({
      companyId: shop.companyId,
      accountId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      isActive: false,
    });

    await reopenFiscalYear({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      fiscalYearId: shop.yearId,
      reason: "The festival spend was billed to the wrong year",
    });
    await closeYear(shop);

    // Retained earnings must carry the year's result, and the year's result is
    // what the profit and loss account said it was — retiring an account does
    // not change what the business earned.
    expect(await retainedEarningsMovement(shop.companyId)).toBeCloseTo(
      profit,
      2,
    );
  }, 120_000);

  it("leaves nothing behind in it either", async () => {
    // The other half of the same promise. A close that skips an account leaves
    // a balance sitting in the year it has just declared settled, and every
    // later reading of that year still shows the expense.
    const { shop, accountId } = await shopWithARetirableExpense();

    await closeEveryMonth(shop);
    await closeYear(shop);
    await setAccountActive({
      companyId: shop.companyId,
      accountId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      isActive: false,
    });
    await reopenFiscalYear({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      fiscalYearId: shop.yearId,
      reason: "The festival spend was billed to the wrong year",
    });
    await closeYear(shop);

    const after = await statementsFor(shop);
    // The expense still belongs to the year it was incurred in; what the close
    // settles is the balance sheet, and nothing is left in the income accounts
    // for it to count as equity a second time.
    expect(Number(after.profitAndLoss.expensesTotal)).toBeGreaterThan(0);
    expect(Number(after.balanceSheet.earningsToDate)).toBe(0);
    expect(after.balanceSheet.balanced).toBe(true);
  }, 120_000);

  it("brings the retired account itself to nil", async () => {
    // Said of the account rather than of a total, because a total can come out
    // right for the wrong reason. Closing a year means every account that
    // measures it reads nil at its end — the retired one included, since it is
    // the only reason the year's figures moved at all.
    const { shop, accountId } = await shopWithARetirableExpense();

    await closeEveryMonth(shop);
    await closeYear(shop);
    await setAccountActive({
      companyId: shop.companyId,
      accountId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      isActive: false,
    });
    await reopenFiscalYear({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      fiscalYearId: shop.yearId,
      reason: "The festival spend was billed to the wrong year",
    });
    await closeYear(shop);

    const balances = await accountBalances({
      companyId: shop.companyId,
      to: shop.to,
    });
    const retiredAccount = balances.find((entry) => entry.id === accountId);

    expect(retiredAccount).toBeDefined();
    expect(retiredAccount!.balance.toFixed(2)).toBe("0.00");
  }, 120_000);
});

/**
 * The cash projection, read in the quarter after a year end.
 *
 * The projection works out what a shop spends running itself from the last
 * thirteen weeks of its profit and loss account, then subtracts that from every
 * week ahead. A closing entry credits each expense account by the whole of its
 * year's balance on one day, and that day sits inside a thirteen-week window
 * from the first of April until about the end of June — the whole of the first
 * quarter of every year, for every shop that closes its books.
 *
 * Inside that quarter the sum was a quarter's debits against a year's credit,
 * which does not fall to nil but goes past it. A negative running cost is
 * subtracted from each week and so *adds* money to it: the line climbs, the
 * shortfall week disappears, and the shop is told it never runs out of cash.
 * That is the one thing this projection exists to say, failing in the direction
 * that does the damage, in the quarter a shop is least sure of its money.
 */
describe("the cash projection, across a year end", () => {
  const DAY = 86_400_000;

  /**
   * A shop with a year of spending behind it, ready to close.
   *
   * Some of the spending is inside the thirteen-week window the projection
   * reads and some is well before it, which is the shape that makes the failure
   * visible: with everything inside the window a closing entry cancels the sum
   * to nil, and nil is a wrong answer that still looks like an answer. With
   * spending outside it too, the year's credit is larger than the window's
   * debits and the running cost comes out below zero.
   */
  async function shopWithASpentYear() {
    const email = `ycp-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
    createdEmails.push(email);
    const owner = await registerOwner(registrationInput(email));
    createdCompanies.push(owner.companyId);

    const now = new Date();
    const provisioned = await prisma.$transaction((tx) =>
      provisionCompany(tx, {
        name: "Year End Forecast Mart",
        slug: uniqueSlug("yearendforecast"),
        stateCode: "29",
        fiscalYearStartMonth: 4,
        asOf: new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 15),
        ),
      }),
    );
    createdCompanies.push(provisioned.companyId);

    const companyId = provisioned.companyId;
    const cash = provisioned.accountsBySystemKey.get(SYSTEM_ACCOUNT.CASH)!;
    const rent = provisioned.accountsBySystemKey.get(
      SYSTEM_ACCOUNT.RENT_EXPENSE,
    )!;
    const year = await prisma.fiscalYear.findFirstOrThrow({
      where: { companyId },
      select: { id: true, startDate: true, endDate: true },
      orderBy: { startDate: "asc" },
    });

    // Twenty days after the year ended: far enough in to be a real April, close
    // enough that the closing entry is inside the thirteen-week window.
    const today = new Date(year.endDate.getTime() + 20 * DAY);

    const spending: Array<[Date, number]> = [
      // Well outside the window. Only the closing entry carries this back into
      // it, which is the whole of the defect.
      [new Date(year.startDate.getTime() + 20 * DAY), 60_000],
      // Inside it, and the only rent the projection should be reading.
      [new Date(year.endDate.getTime() - 40 * DAY), 20_000],
      [new Date(year.endDate.getTime() - 10 * DAY), 20_000],
    ];

    for (const [on, amount] of spending) {
      await prisma.$transaction((tx) =>
        postJournalEntry(tx, {
          companyId,
          entryDate: on,
          voucherType: VoucherType.JOURNAL,
          createdById: owner.userId,
          narration: "Shop rent",
          lines: [
            { accountId: rent, debit: amount },
            { accountId: cash, credit: amount },
          ],
        }),
      );
    }

    return {
      shop: {
        companyId,
        userId: owner.userId,
        yearId: year.id,
        from: year.startDate,
        to: year.endDate,
      },
      today,
    };
  }

  it("still knows what the shop spends running itself", async () => {
    const { shop, today } = await shopWithASpentYear();

    const before = await getCashProjection({
      companyId: shop.companyId,
      weeks: 13,
      today,
    });
    // Two months' rent over a thirteen-week window, and nothing else in it.
    expect(Number(before.weeklyRunningCost)).toBeCloseTo(40_000 / 13, 2);

    await closeEveryMonth(shop);
    await closeFiscalYear({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      fiscalYearId: shop.yearId,
    });

    const after = await getCashProjection({
      companyId: shop.companyId,
      weeks: 13,
      today,
    });

    expect(Number(after.weeklyRunningCost)).toBeCloseTo(
      Number(before.weeklyRunningCost),
      2,
    );
    // Said separately, because the sign is the part that does the damage: a
    // running cost below nil is added to every week rather than taken off it.
    expect(Number(after.weeklyRunningCost)).toBeGreaterThan(0);
  }, 120_000);

  it("still runs the projected cash down week by week", async () => {
    // The consequence, rather than the input to it. A shop with no receipts
    // ahead of it spends its way down; a negative running cost turns that line
    // around and the projection stops being a warning about anything.
    const { shop, today } = await shopWithASpentYear();

    await closeEveryMonth(shop);
    await closeFiscalYear({
      companyId: shop.companyId,
      userId: shop.userId,
      actorEmail: "owner@example.com",
      fiscalYearId: shop.yearId,
    });

    const projection = await getCashProjection({
      companyId: shop.companyId,
      weeks: 13,
      today,
    });

    const first = projection.weeks.at(0)!;
    const last = projection.weeks.at(-1)!;
    expect(Number(last.closingCash)).toBeLessThan(Number(first.closingCash));
    expect(Number(last.closingCash)).toBeLessThan(
      Number(projection.openingCash),
    );
  }, 120_000);
});
