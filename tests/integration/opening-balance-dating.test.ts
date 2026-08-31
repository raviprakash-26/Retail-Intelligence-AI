import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JournalStatus } from "@prisma/client";
import type { RegisterInput } from "@/lib/validation/auth";
import type { CustomerInput, ProductInput } from "@/lib/validation/master-data";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { closePeriod, listPeriods } from "@/server/accounting/period-service";
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
 * Where an opening balance is dated once the year's first month is shut.
 *
 * An opening balance belongs at the start of the financial year, and for a
 * long time it was put there unconditionally. Closing April — which closing the
 * year requires, twelve times over — then stopped a shop adding any customer,
 * supplier or product that carried a balance, for the rest of the year:
 *
 *     The accounting period containing 2026-04-01 is closed.
 *     Post to an open period, or reopen it first.
 *
 * A date the person never chose, and advice to undo their own month-end close.
 * The entry now falls forward to the start of the earliest month still open.
 * Nothing is posted into a closed period — that is what closing one is for —
 * and the caller is told the date moved rather than finding out later.
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
      businessName: `Opening ${uniqueSlug("Mart")}`,
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

type Shop = { companyId: string; userId: string };

async function shop(): Promise<Shop> {
  const email = `ob-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const owner = await registerOwner(registrationInput(email));
  createdCompanies.push(owner.companyId);
  return { companyId: owner.companyId, userId: owner.userId };
}

const actor = (shop: Shop) => ({
  companyId: shop.companyId,
  userId: shop.userId,
  actorEmail: "owner@example.com",
});

function customerOwing(amount: number): CustomerInput {
  return {
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
    openingBalance: amount,
    openingNature: "DEBIT",
    notes: "",
  };
}

/** Closes months from the start of the year, in order, as a person would. */
async function closeMonths(shop: Shop, count: number): Promise<string[]> {
  const periods = (await listPeriods(shop.companyId))
    .filter((period) => period.status === "OPEN")
    .sort((a, b) => a.startDate.getTime() - b.startDate.getTime())
    .slice(0, count);

  for (const period of periods) {
    await closePeriod({ ...actor(shop), periodId: period.id });
  }
  return periods.map((period) => period.label);
}

/** The date of the opening entry a party or product wrote. */
async function openingEntryDate(companyId: string, narrationLike: string) {
  const entry = await prisma.journalEntry.findFirstOrThrow({
    where: {
      companyId,
      status: JournalStatus.POSTED,
      voucherType: "OPENING_BALANCE",
      narration: { contains: narrationLike },
    },
    select: { entryDate: true },
    orderBy: { createdAt: "desc" },
  });
  return entry.entryDate;
}

beforeAll(async () => {
  await ensurePlatformData();
}, 60_000);

afterAll(async () => {
  for (const id of createdCompanies) await purgeTestCompany(id);
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

describe("an opening balance when the year has begun to close", () => {
  it("still sits at the start of the year while that month is open", async () => {
    // Unchanged for the shop that has closed nothing, which is most of them.
    const it = await shop();
    const periods = await listPeriods(it.companyId);
    const yearStart = periods
      .map((period) => period.startDate)
      .sort((a, b) => a.getTime() - b.getTime())[0]!;

    const customer = await createParty({
      ...actor(it),
      kind: "CUSTOMER",
      input: customerOwing(8000),
    });

    const dated = await openingEntryDate(it.companyId, "Sharma");
    expect(dated.toISOString()).toBe(yearStart.toISOString());
    // Nothing moved, so there is nothing to tell anyone. The screen stays quiet
    // on the ordinary path rather than explaining a decision it did not make.
    expect(customer.openingDeferredTo).toBeNull();
  }, 90_000);

  it("is accepted after the first month is closed, dated to the next open one", async () => {
    // The defect, exactly: this used to throw "The accounting period containing
    // 2026-04-01 is closed" and leave the shop unable to add the customer at
    // all.
    const it = await shop();
    await closeMonths(it, 1);

    const customer = await createParty({
      ...actor(it),
      kind: "CUSTOMER",
      input: customerOwing(8000),
    });
    expect(customer.id).toBeTruthy();

    const periods = await listPeriods(it.companyId);
    const firstOpen = periods
      .filter((period) => period.status === "OPEN")
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime())[0]!;

    const dated = await openingEntryDate(it.companyId, "Sharma");
    expect(dated.toISOString()).toBe(firstOpen.startDate.toISOString());

    // And says so. A date the shop did not choose is only acceptable if the
    // shop is told about it, which means the date has to leave the service.
    expect(customer.openingDeferredTo).toBe(
      firstOpen.startDate.toISOString().slice(0, 10),
    );
  }, 90_000);

  it("does the same for a product carrying opening stock", async () => {
    const it = await shop();
    await closeMonths(it, 3);

    const taxonomy = await getProductTaxonomy(it.companyId);
    const unit = taxonomy.units.find((entry) => entry.code === "PCS")!;

    const product = await createProduct({
      ...actor(it),
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
        openingQuantity: 40,
        openingRate: 60,
        minStockLevel: 0,
      } satisfies ProductInput,
    });
    expect(product.id).toBeTruthy();

    const periods = await listPeriods(it.companyId);
    const firstOpen = periods
      .filter((period) => period.status === "OPEN")
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime())[0]!;

    const dated = await openingEntryDate(it.companyId, "Widget");
    expect(dated.toISOString()).toBe(firstOpen.startDate.toISOString());
    expect(product.openingDeferredTo).toBe(
      firstOpen.startDate.toISOString().slice(0, 10),
    );
  }, 90_000);

  it("says nothing about a product that starts with no stock", async () => {
    // A product with no opening stock writes no opening entry, so there is no
    // date to have moved — the report is about a decision actually taken, not
    // about the year being partly closed.
    const it = await shop();
    await closeMonths(it, 3);

    const taxonomy = await getProductTaxonomy(it.companyId);
    const unit = taxonomy.units.find((entry) => entry.code === "PCS")!;

    const product = await createProduct({
      ...actor(it),
      input: {
        sku: "SERVICE",
        name: "Fitting service",
        description: "",
        barcode: "",
        hsnCode: "",
        categoryId: "",
        unitId: unit.id,
        taxRateId: "",
        purchasePrice: 0,
        sellingPrice: 500,
        mrp: 0,
        isStockTracked: false,
        openingQuantity: 0,
        openingRate: 0,
        minStockLevel: 0,
      } satisfies ProductInput,
    });

    expect(product.openingEntry).toBeNull();
    expect(product.openingDeferredTo).toBeNull();
  }, 90_000);

  it("never posts into a month that has been closed", async () => {
    // The property that matters more than where the entry lands: closing a
    // month has to mean the month stops moving.
    const it = await shop();
    const closed = await closeMonths(it, 5);

    await createParty({
      ...actor(it),
      kind: "CUSTOMER",
      input: customerOwing(12_000),
    });

    const dated = await openingEntryDate(it.companyId, "Sharma");
    const holding = (await listPeriods(it.companyId)).find((period) =>
      coversDay(period, dated),
    );

    expect(holding).toBeDefined();
    expect(holding!.status).toBe("OPEN");
    expect(closed).not.toContain(holding!.label);
  }, 90_000);

  it("refuses, and says what to do, when every month is closed", async () => {
    const it = await shop();
    await closeMonths(it, 12);

    await expect(
      createParty({
        ...actor(it),
        kind: "CUSTOMER",
        input: customerOwing(8000),
      }),
    ).rejects.toThrow(/every month of .* is closed/i);

    // A customer who owes nothing writes no opening entry, so a fully closed
    // year does not stop the shop keeping its address book.
    const plain = await createParty({
      ...actor(it),
      kind: "CUSTOMER",
      input: { ...customerOwing(0), name: "Nagarjuna Traders" },
    });
    expect(plain.id).toBeTruthy();
  }, 90_000);
});
