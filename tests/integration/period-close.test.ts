import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegisterInput } from "@/lib/validation/auth";
import type { CustomerInput, ProductInput } from "@/lib/validation/master-data";
import type { SaleInput } from "@/lib/validation/sales";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale } from "@/server/sales/sale-service";
import { VoucherType } from "@prisma/client";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import {
  closePeriod,
  listPeriods,
  reopenPeriod,
  PeriodError,
} from "@/server/accounting/period-service";
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
 * Closing the books on a period.
 *
 * The guard that refuses to post into a closed period has always been correct
 * and has never been reachable: nothing in the application could close a
 * period, so the only test of it wrote `status: 'CLOSED'` into the database by
 * hand. These cases close a period the way a person would, and then check that
 * the refusal fires — which is the first time that path has been exercised
 * end to end.
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

async function shop(): Promise<Fixture> {
  const email = `close-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
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
    companyId: result.companyId,
    userId: result.userId,
    customerId: customer.id,
    productId: product.id,
  };
}

const actor = (fixture: Fixture) => ({
  companyId: fixture.companyId,
  userId: fixture.userId,
  actorEmail: "owner@example.com",
});

async function sell(fixture: Fixture, on: Date) {
  return createSale({
    ...actor(fixture),
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

/** The period containing today, which is where a new shop trades. */
async function currentPeriod(fixture: Fixture) {
  const periods = await listPeriods(fixture.companyId);
  const now = new Date();
  const found = periods.find((period) => coversDay(period, now));
  if (!found) throw new Error("No period covers today");
  return found;
}

/** Everything before it, so ordering does not block the case under test. */
async function closeEverythingBefore(fixture: Fixture, before: Date) {
  const periods = await listPeriods(fixture.companyId);
  const earlier = periods
    .filter((period) => period.startDate.getTime() < before.getTime())
    .sort((a, b) => a.startDate.getTime() - b.startDate.getTime());

  for (const period of earlier) {
    if (period.status !== "OPEN") continue;
    await closePeriod({ ...actor(fixture), periodId: period.id });
  }
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
});

describe("closing a period", () => {
  it("stops anything further being posted into it", async () => {
    // The case the guard was written for, reached the way a person reaches it.
    const fixture = await shop();
    const today = new Date();

    await sell(fixture, today);

    const period = await currentPeriod(fixture);
    await closeEverythingBefore(fixture, period.startDate);
    await closePeriod({ ...actor(fixture), periodId: period.id });

    await expect(sell(fixture, today)).rejects.toThrow(/closed/i);
  }, 180_000);

  it("leaves what was already posted exactly where it is", async () => {
    // Closing freezes a period; it does not remove anything from it.
    const fixture = await shop();
    const today = new Date();
    await sell(fixture, today);

    const before = await prisma.journalEntry.count({
      where: { companyId: fixture.companyId },
    });

    const period = await currentPeriod(fixture);
    await closeEverythingBefore(fixture, period.startDate);
    await closePeriod({ ...actor(fixture), periodId: period.id });

    const after = await prisma.journalEntry.count({
      where: { companyId: fixture.companyId },
    });
    expect(after).toBe(before);
  }, 180_000);

  it("records who closed it, and when", async () => {
    const fixture = await shop();
    const period = await currentPeriod(fixture);
    await closeEverythingBefore(fixture, period.startDate);

    const closed = await closePeriod({
      ...actor(fixture),
      periodId: period.id,
      note: "GSTR-1 filed",
    });
    expect(closed.status).toBe("CLOSED");
    expect(closed.closedAt).not.toBeNull();

    const entry = await prisma.auditLog.findFirst({
      where: {
        companyId: fixture.companyId,
        action: "fiscalPeriod.closed",
        entityId: period.id,
      },
      select: { metadata: true },
    });
    expect(entry).not.toBeNull();
  }, 180_000);

  it("refuses while a draft entry is still sitting in it", async () => {
    // Closing over a draft would either strand it or force it into the next
    // period, and being told to deal with it is better than either. This case
    // exists because removing the guard did not fail anything — the rule was
    // described in a comment and proved by nothing.
    const fixture = await shop();
    const period = await currentPeriod(fixture);
    await closeEverythingBefore(fixture, period.startDate);

    // Resolved by systemKey rather than by code: the code can be renamed by a
    // business, which is exactly why the posting rules use the key.
    const accounts = await prisma.account.findMany({
      where: { companyId: fixture.companyId, systemKey: { not: null } },
      select: { id: true, systemKey: true },
    });
    const byKey = (key: string) =>
      accounts.find((account) => account.systemKey === key)?.id;
    const cash = byKey(SYSTEM_ACCOUNT.CASH);
    const sales = byKey(SYSTEM_ACCOUNT.SALES);
    if (!cash || !sales) throw new Error("Chart of accounts is incomplete");

    await postJournalEntry(prisma, {
      companyId: fixture.companyId,
      entryDate: new Date(),
      voucherType: VoucherType.JOURNAL,
      status: "DRAFT",
      lines: [
        { accountId: cash, debit: 100 },
        { accountId: sales, credit: 100 },
      ],
    });

    const withDraft = await currentPeriod(fixture);
    expect(withDraft.pending.journalDrafts).toBe(1);
    expect(withDraft.closable).toBe(false);

    await expect(
      closePeriod({ ...actor(fixture), periodId: period.id }),
    ).rejects.toThrow(/draft/i);
  }, 180_000);

  it("refuses to close twice", async () => {
    const fixture = await shop();
    const period = await currentPeriod(fixture);
    await closeEverythingBefore(fixture, period.startDate);
    await closePeriod({ ...actor(fixture), periodId: period.id });

    await expect(
      closePeriod({ ...actor(fixture), periodId: period.id }),
    ).rejects.toBeInstanceOf(PeriodError);
  }, 180_000);

  it("refuses while an earlier period is still open", async () => {
    // A closed March behind an open February says nothing useful about either.
    const fixture = await shop();
    const period = await currentPeriod(fixture);

    const earlier = (await listPeriods(fixture.companyId)).find(
      (entry) => entry.startDate.getTime() < period.startDate.getTime(),
    );
    if (!earlier) return; // the shop opened in the first period of its year

    await expect(
      closePeriod({ ...actor(fixture), periodId: period.id }),
    ).rejects.toThrow(/still open/i);
  }, 180_000);

  it("will not touch a period belonging to another company", async () => {
    const [mine, theirs] = await Promise.all([shop(), shop()]);
    const period = await currentPeriod(theirs);

    await expect(
      closePeriod({ ...actor(mine), periodId: period.id }),
    ).rejects.toThrow(/could not be found/i);
  }, 180_000);
});

describe("reopening one", () => {
  it("lets entries be posted again", async () => {
    // A mistake found after closing has to be correctable, or closing becomes
    // a thing nobody dares do.
    const fixture = await shop();
    const today = new Date();

    const period = await currentPeriod(fixture);
    await closeEverythingBefore(fixture, period.startDate);
    await closePeriod({ ...actor(fixture), periodId: period.id });
    await expect(sell(fixture, today)).rejects.toThrow(/closed/i);

    await reopenPeriod({
      ...actor(fixture),
      periodId: period.id,
      reason: "A supplier bill arrived late and belongs in this month",
    });

    const sale = await sell(fixture, today);
    expect(sale.id).toBeTruthy();
  }, 180_000);

  it("demands a reason and keeps it", async () => {
    // Reopening means figures behind something already filed can change. The
    // person who finds that later needs to know why.
    const fixture = await shop();
    const period = await currentPeriod(fixture);
    await closeEverythingBefore(fixture, period.startDate);
    await closePeriod({ ...actor(fixture), periodId: period.id });

    await expect(
      reopenPeriod({ ...actor(fixture), periodId: period.id, reason: "  " }),
    ).rejects.toThrow(/say why/i);

    await reopenPeriod({
      ...actor(fixture),
      periodId: period.id,
      reason: "Correcting a misposted expense",
    });

    const entry = await prisma.auditLog.findFirst({
      where: {
        companyId: fixture.companyId,
        action: "fiscalPeriod.reopened",
        entityId: period.id,
      },
      select: { metadata: true },
    });
    expect(JSON.stringify(entry?.metadata)).toContain("misposted");
  }, 180_000);

  it("refuses to reopen one that is already open", async () => {
    const fixture = await shop();
    const period = await currentPeriod(fixture);
    await expect(
      reopenPeriod({
        ...actor(fixture),
        periodId: period.id,
        reason: "No reason at all",
      }),
    ).rejects.toThrow(/already open/i);
  }, 180_000);
});

describe("what the page shows", () => {
  it("says what closing a period would be freezing", async () => {
    const fixture = await shop();
    await sell(fixture, new Date());

    const period = await currentPeriod(fixture);
    expect(period.postedEntries).toBeGreaterThan(0);
    expect(period.status).toBe("OPEN");
  }, 180_000);

  it("lists only this company's periods", async () => {
    const [mine, theirs] = await Promise.all([shop(), shop()]);
    const mineIds = (await listPeriods(mine.companyId)).map((p) => p.id);
    const theirIds = new Set(
      (await listPeriods(theirs.companyId)).map((p) => p.id),
    );

    expect(mineIds.length).toBeGreaterThan(0);
    expect(mineIds.some((id) => theirIds.has(id))).toBe(false);
  }, 180_000);
});
