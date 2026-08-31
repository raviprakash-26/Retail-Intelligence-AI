import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegisterInput } from "@/lib/validation/auth";
import type { CustomerInput, ProductInput } from "@/lib/validation/master-data";
import type { SaleInput } from "@/lib/validation/sales";
import {
  COMPANY_SERIES,
  FISCAL_YEAR_SERIES,
  seriesPrefix,
} from "@/lib/documents/sequences";
import { VoucherType } from "@prisma/client";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { registerOwner } from "@/server/auth/registration";
import {
  NoFiscalPeriodError,
  postJournalEntry,
} from "@/server/accounting/post-journal-entry";
import { ensureFiscalYearFor } from "@/server/fiscal/fiscal-calendar";
import { provisionCompany } from "@/server/provisioning/company-provisioner";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale } from "@/server/sales/sale-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";
import { coversDay } from "../helpers/calendar";

/**
 * The calendar a tenant is given at signup, and what happens when it runs out.
 *
 * Provisioning created one fiscal year and twelve periods, and nothing in the
 * product ever created another — `fiscalYear.create` appeared in exactly one
 * file. Every tenant was therefore trading on a calendar with an end date, and
 * on the first day of the next year a shop could not raise an invoice, record a
 * bill, log an expense, take a receipt, pay a supplier or run payroll. Every
 * one of those posts an entry and every entry needs a period.
 *
 * These cases move a company rather than the clock: a company provisioned
 * thirteen months ago is in exactly the position every real tenant reaches by
 * waiting, and `asOf` is provisioning's own parameter rather than a row written
 * behind the application's back.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

const DAY_MS = 86_400_000;

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
      businessName: `Calendar ${uniqueSlug("Mart")}`,
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
  customerId: string;
  productId: string;
};

/** A signed-up owner, whose company is not the one under test. */
async function anOwner(): Promise<string> {
  const email = `cal-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);
  return result.userId;
}

/**
 * A shop that signed up on `asOf` and has been trading since.
 *
 * Provisioned directly because registration always signs a company up today,
 * and the whole question here is what happens to one that did not.
 */
async function shopSignedUpOn(asOf: Date): Promise<Fixture> {
  const userId = await anOwner();

  const provisioned = await prisma.$transaction((tx) =>
    provisionCompany(tx, {
      name: "Older Mart",
      slug: uniqueSlug("older"),
      stateCode: "29",
      fiscalYearStartMonth: 4,
      asOf,
    }),
  );
  createdCompanies.push(provisioned.companyId);

  const base = {
    companyId: provisioned.companyId,
    userId,
    actorEmail: "owner@example.com",
  };

  const taxonomy = await getProductTaxonomy(provisioned.companyId);
  const unit = taxonomy.units.find((entry) => entry.code === "PCS");
  if (!unit) throw new Error("Provisioning is incomplete");

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
      openingQuantity: 500,
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

  return {
    companyId: provisioned.companyId,
    userId,
    customerId: customer.id,
    productId: product.id,
  };
}

async function sell(fixture: Fixture, on: Date) {
  return createSale({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: "owner@example.com",
    branchId: null,
    input: {
      customerId: fixture.customerId,
      invoiceDate: on.toISOString().slice(0, 10),
      paymentMode: "CASH",
      placeOfSupply: "",
      priceIncludesTax: false,
      notes: "",
      lines: [
        {
          productId: fixture.productId,
          description: "",
          quantity: 1,
          rate: 250,
          discountPercent: 0,
        },
      ],
    } satisfies SaleInput,
  });
}

async function fiscalYears(companyId: string) {
  return prisma.fiscalYear.findMany({
    where: { companyId },
    select: {
      id: true,
      label: true,
      startDate: true,
      endDate: true,
      isCurrent: true,
    },
    orderBy: { startDate: "asc" },
  });
}

function yearCovering<T extends { startDate: Date; endDate: Date }>(
  years: readonly T[],
  date: Date,
): T | undefined {
  return years.find((year) => coversDay(year, date));
}

/** Months back from today, as a day inside that month. */
function monthsAgo(months: number): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 15),
  );
}

beforeAll(async () => {
  await ensurePlatformData();
}, 60_000);

afterAll(async () => {
  for (const id of createdCompanies) await purgeTestCompany(id);
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

describe("a fiscal year that has ended", () => {
  it("does not stop the shop trading", async () => {
    const today = new Date();
    const fixture = await shopSignedUpOn(monthsAgo(13));

    const before = await fiscalYears(fixture.companyId);
    expect(yearCovering(before, today)).toBeUndefined();

    // The whole defect in one line: this used to fail, and not even legibly —
    // the document number is allocated before the entry is posted, so the shop
    // was told `No document sequence "SALE" configured for company …`.
    const sale = await sell(fixture, today);

    const after = await fiscalYears(fixture.companyId);
    const opened = yearCovering(after, today);
    expect(opened).toBeDefined();

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId: fixture.companyId, sourceId: sale.id },
      select: { fiscalYearId: true },
    });
    expect(entry.fiscalYearId).toBe(opened!.id);

    const periods = await prisma.fiscalPeriod.count({
      where: { fiscalYearId: opened!.id },
    });
    expect(periods).toBe(12);
  }, 60_000);

  it("opens the year for an entry posted straight to the ledger", async () => {
    // A journal voucher, a stock adjustment and a bank entry reach the ledger
    // with no document service in front of them, so the calendar has to be in
    // the posting funnel too and not only in the seven services that number a
    // document first.
    const today = new Date();
    const fixture = await shopSignedUpOn(monthsAgo(13));

    const accounts = await prisma.account.findMany({
      where: {
        companyId: fixture.companyId,
        systemKey: { in: [SYSTEM_ACCOUNT.CASH, SYSTEM_ACCOUNT.SALES] },
      },
      select: { id: true, systemKey: true },
    });
    const accountId = (key: string) =>
      accounts.find((account) => account.systemKey === key)!.id;

    const entry = await prisma.$transaction((tx) =>
      postJournalEntry(tx, {
        companyId: fixture.companyId,
        entryDate: today,
        voucherType: VoucherType.JOURNAL,
        createdById: fixture.userId,
        lines: [
          { accountId: accountId(SYSTEM_ACCOUNT.CASH), debit: 100 },
          { accountId: accountId(SYSTEM_ACCOUNT.SALES), credit: 100 },
        ],
      }),
    );

    const opened = yearCovering(await fiscalYears(fixture.companyId), today);
    expect(opened).toBeDefined();

    const written = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId: fixture.companyId, entryNumber: entry.entryNumber },
      select: { fiscalYearId: true },
    });
    expect(written.fiscalYearId).toBe(opened!.id);
  }, 60_000);

  it("opens it once when two tills sell at the same moment", async () => {
    // Nine o'clock on the first of April, two counters, no year yet. Both find
    // it missing; without the lock both open it and Postgres rejects one on
    // `@@unique([companyId, label])` — which, inside a transaction, is the
    // sale being posted rather than just the year.
    const today = new Date();
    const fixture = await shopSignedUpOn(monthsAgo(13));

    const sales = await Promise.all([
      sell(fixture, today),
      sell(fixture, today),
      sell(fixture, today),
    ]);

    const years = await fiscalYears(fixture.companyId);
    expect(years.filter((year) => yearCovering([year], today))).toHaveLength(1);
    expect(new Set(sales.map((sale) => sale.invoiceNumber)).size).toBe(3);
  }, 60_000);

  it("hands the new year its own document series", async () => {
    const today = new Date();
    const fixture = await shopSignedUpOn(monthsAgo(13));

    const first = await sell(fixture, today);
    const opened = yearCovering(await fiscalYears(fixture.companyId), today)!;

    const sequences = await prisma.documentSequence.findMany({
      where: { companyId: fixture.companyId, fiscalYearId: opened.id },
      select: { key: true },
    });
    expect(sequences.map((row) => row.key).sort()).toEqual(
      FISCAL_YEAR_SERIES.map((series) => series.key).sort(),
    );

    // A series belongs to its year, so the new one starts at 1 — carrying the
    // year, which is what keeps the restart from colliding with last year's
    // INV-0001 on `@@unique([companyId, invoiceNumber])`.
    expect(first.invoiceNumber).toBe(
      `${seriesPrefix("INV-", opened.label)}0001`,
    );

    const masters = await prisma.documentSequence.findMany({
      where: { companyId: fixture.companyId, fiscalYearId: null },
      select: { key: true },
    });
    expect(masters.map((row) => row.key).sort()).toEqual(
      COMPANY_SERIES.map((series) => series.key).sort(),
    );
  }, 60_000);

  it("keeps the years' numbering apart", async () => {
    const today = new Date();
    const fixture = await shopSignedUpOn(monthsAgo(13));
    const oldYear = (await fiscalYears(fixture.companyId))[0]!;
    const insideOldYear = new Date(oldYear.startDate.getTime() + 40 * DAY_MS);

    const firstOfOld = await sell(fixture, insideOldYear);
    const firstOfNew = await sell(fixture, today);
    const secondOfOld = await sell(fixture, insideOldYear);

    const newYear = yearCovering(await fiscalYears(fixture.companyId), today)!;
    const oldSeries = seriesPrefix("INV-", oldYear.label);
    const newSeries = seriesPrefix("INV-", newYear.label);

    expect(firstOfOld.invoiceNumber).toBe(`${oldSeries}0001`);
    expect(firstOfNew.invoiceNumber).toBe(`${newSeries}0001`);
    // Opening a year must not disturb the counter of the one before it.
    expect(secondOfOld.invoiceNumber).toBe(`${oldSeries}0002`);
    expect(oldSeries).not.toBe(newSeries);
  }, 60_000);

  it("moves the current year onto the one containing today", async () => {
    const today = new Date();
    const fixture = await shopSignedUpOn(monthsAgo(13));

    await sell(fixture, today);

    const years = await fiscalYears(fixture.companyId);
    const current = years.filter((year) => year.isCurrent);
    // A partial unique index allows only one, and reports default to it — left
    // on the year that ended, every screen would open on last year's figures.
    expect(current).toHaveLength(1);
    expect(current[0]!.id).toBe(yearCovering(years, today)!.id);
  }, 60_000);

  it("still finds the year at two in the afternoon on its last day", async () => {
    // The year's bounds are days, stored at midnight, and this is asked with a
    // timestamp. It holds because Prisma sends a date parameter for a date
    // column — an assumption worth pinning rather than trusting: if it stopped
    // holding, every tenant would be told its current year did not exist on the
    // last day of it, and would be handed a spurious new one.
    const fixture = await shopSignedUpOn(monthsAgo(13));
    const oldYear = (await fiscalYears(fixture.companyId))[0]!;
    const lastAfternoon = new Date(oldYear.endDate.getTime() + 14 * 3_600_000);

    const found = await prisma.$transaction((tx) =>
      ensureFiscalYearFor(tx, {
        companyId: fixture.companyId,
        date: lastAfternoon,
        asOf: lastAfternoon,
      }),
    );

    expect(found.id).toBe(oldYear.id);
    expect(await fiscalYears(fixture.companyId)).toHaveLength(1);
  }, 60_000);

  it("leaves no hole when a shop comes back after two quiet years", async () => {
    const today = new Date();
    const fixture = await shopSignedUpOn(monthsAgo(37));

    await sell(fixture, today);

    const years = await fiscalYears(fixture.companyId);
    expect(yearCovering(years, today)).toBeDefined();

    // Contiguous: each year starts the day after the one before it ends.
    // Periods close in order, and a missing year is a hole ordering cannot
    // step over.
    for (let index = 1; index < years.length; index += 1) {
      expect(years[index]!.startDate.getTime()).toBe(
        years[index - 1]!.endDate.getTime() + DAY_MS,
      );
    }

    for (const year of years) {
      const periods = await prisma.fiscalPeriod.count({
        where: { fiscalYearId: year.id },
      });
      expect(periods).toBe(12);
    }
  }, 90_000);
});

describe("a date no fiscal year should exist for", () => {
  it("refuses a year that has not started", async () => {
    const fixture = await shopSignedUpOn(monthsAgo(13));
    const before = await fiscalYears(fixture.companyId);

    const twoYearsOn = new Date(
      Date.UTC(new Date().getUTCFullYear() + 2, 5, 15),
    );

    await expect(sell(fixture, twoYearsOn)).rejects.toBeInstanceOf(
      // Reported as "no period covers this date", which is what every action
      // already turns into a message a shopkeeper can act on.
      NoFiscalPeriodError,
    );

    // Called directly, so a missing guard would commit rather than roll back
    // with the document.
    await expect(
      prisma.$transaction((tx) =>
        ensureFiscalYearFor(tx, {
          companyId: fixture.companyId,
          date: twoYearsOn,
        }),
      ),
    ).rejects.toThrow(/has not started yet/);

    expect(await fiscalYears(fixture.companyId)).toHaveLength(before.length);
  }, 60_000);

  it("refuses a date before the business existed", async () => {
    const fixture = await shopSignedUpOn(monthsAgo(13));
    const before = await fiscalYears(fixture.companyId);
    const beforeTheFirstYear = new Date(
      before[0]!.startDate.getTime() - 40 * DAY_MS,
    );

    await expect(sell(fixture, beforeTheFirstYear)).rejects.toBeInstanceOf(
      NoFiscalPeriodError,
    );

    await expect(
      prisma.$transaction((tx) =>
        ensureFiscalYearFor(tx, {
          companyId: fixture.companyId,
          date: beforeTheFirstYear,
        }),
      ),
    ).rejects.toThrow(/before this business's first fiscal year/);

    expect(await fiscalYears(fixture.companyId)).toHaveLength(before.length);
  }, 60_000);
});

describe("provisioning", () => {
  it("still gives a new company one year, twelve periods and every series", async () => {
    const email = `cal-new-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
    createdEmails.push(email);
    const result = await registerOwner(registrationInput(email));
    createdCompanies.push(result.companyId);

    const years = await fiscalYears(result.companyId);
    expect(years).toHaveLength(1);
    expect(yearCovering(years, new Date())).toBeDefined();
    expect(years[0]!.isCurrent).toBe(true);

    const periods = await prisma.fiscalPeriod.count({
      where: { companyId: result.companyId },
    });
    expect(periods).toBe(12);

    const yearScoped = await prisma.documentSequence.findMany({
      where: { companyId: result.companyId, fiscalYearId: years[0]!.id },
      select: { key: true },
    });
    expect(yearScoped.map((row) => row.key).sort()).toEqual(
      FISCAL_YEAR_SERIES.map((series) => series.key).sort(),
    );

    const companyScoped = await prisma.documentSequence.findMany({
      where: { companyId: result.companyId, fiscalYearId: null },
      select: { key: true },
    });
    expect(companyScoped.map((row) => row.key).sort()).toEqual(
      COMPANY_SERIES.map((series) => series.key).sort(),
    );
  }, 60_000);
});
