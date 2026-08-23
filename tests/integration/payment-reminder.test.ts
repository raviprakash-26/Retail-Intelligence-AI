import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegisterInput } from "@/lib/validation/auth";
import type { CustomerInput, ProductInput } from "@/lib/validation/master-data";
import type { SaleInput } from "@/lib/validation/sales";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale } from "@/server/sales/sale-service";
import {
  paymentReminderEmail,
  reminderPreview,
} from "@/server/settlements/payment-reminder";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * What a reminder would say, read off the books.
 *
 * The figures in a reminder are the ones the shop will have to defend if the
 * customer disagrees, so they come from the posted documents rather than any
 * separate tally kept for chasing. These cases check that they do — and that
 * one shop's overdue account can never appear in another shop's reminder.
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
      businessName: `Remind ${uniqueSlug("Mart")}`,
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

type Fixture = { companyId: string; userId: string; customerId: string };

/** A shop with one credit customer and one invoice raised `daysAgo` ago. */
async function shopWithDebt(daysAgo: number, amount = 250): Promise<Fixture> {
  const email = `remind-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
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
      sellingPrice: amount,
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
      email: "accounts@sharma.example",
      gstin: "",
      pan: "",
      addressLine1: "",
      city: "",
      stateCode: "29",
      pincode: "",
      creditDays: 0,
      creditLimit: 100_000_000,
      openingBalance: 0,
      openingNature: "DEBIT",
      notes: "",
    } satisfies CustomerInput,
  });

  const invoiceDate = new Date();
  invoiceDate.setDate(invoiceDate.getDate() - daysAgo);

  await createSale({
    ...base,
    branchId: null,
    input: {
      customerId: customer.id,
      invoiceDate: invoiceDate.toISOString().slice(0, 10),
      paymentMode: "CREDIT",
      placeOfSupply: "",
      priceIncludesTax: false,
      notes: "",
      lines: [
        {
          productId: product.id,
          description: "",
          quantity: 1,
          rate: amount,
          discountPercent: 0,
        },
      ],
    } satisfies SaleInput,
  });

  return {
    companyId: result.companyId,
    userId: result.userId,
    customerId: customer.id,
  };
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

describe("what the shop would be sending", () => {
  it("reads the amount off the posted invoice", async () => {
    const shop = await shopWithDebt(40, 250);
    const preview = await reminderPreview({
      companyId: shop.companyId,
      customerId: shop.customerId,
    });

    expect(preview).not.toBeNull();
    expect(preview?.invoices).toHaveLength(1);

    // Whatever tax was added, the outstanding is the invoice's own total.
    const sale = await prisma.sale.findFirstOrThrow({
      where: { companyId: shop.companyId },
      select: { totalAmount: true, invoiceNumber: true },
    });
    expect(preview?.invoices[0]?.number).toBe(sale.invoiceNumber);
    expect(Number(preview?.totalOutstanding)).toBeCloseTo(
      Number(sale.totalAmount),
      2,
    );
  }, 120_000);

  it("counts overdue from the due date, not the invoice date", async () => {
    // On nil credit days the due date is the invoice date, so a 40-day-old
    // invoice is 40 days late — not 40 days old and current.
    const shop = await shopWithDebt(40);
    const preview = await reminderPreview({
      companyId: shop.companyId,
      customerId: shop.customerId,
    });

    expect(preview?.oldestOverdueDays).toBe(40);
    expect(Number(preview?.totalOverdue)).toBeGreaterThan(0);
  }, 120_000);

  it("has nothing to say once the invoice is settled", async () => {
    const shop = await shopWithDebt(40);

    // Settle it the way the application does, then look again.
    const sale = await prisma.sale.findFirstOrThrow({
      where: { companyId: shop.companyId },
      select: { id: true, totalAmount: true },
    });
    await prisma.sale.update({
      where: { id: sale.id },
      data: { paidAmount: sale.totalAmount },
    });

    const preview = await reminderPreview({
      companyId: shop.companyId,
      customerId: shop.customerId,
    });
    expect(preview?.invoices).toEqual([]);
    expect(Number(preview?.totalOutstanding)).toBe(0);
  }, 120_000);

  it("says nobody has been reminded yet", async () => {
    const shop = await shopWithDebt(40);
    const preview = await reminderPreview({
      companyId: shop.companyId,
      customerId: shop.customerId,
    });
    expect(preview?.lastRemindedAt).toBeNull();
  }, 120_000);
});

/**
 * The day an invoice falls due, read in the evening.
 *
 * "It states facts and nothing else" is the first promise this module makes,
 * and the fact most easily got wrong is the one in the subject line. Lateness
 * was worked out by subtracting two instants and rounding, so once the clock
 * passed midday UTC — half past five in the evening in the shop — an invoice
 * due that day rounded up to one day late. A retailer does the books after the
 * shutters come down, which is exactly when this was wrong.
 *
 * What went out was not a statement of account with a wrong number in it. The
 * subject changed to "Payment reminder", the first line said money was past its
 * due date, and the invoice was listed as a day overdue on the day it fell due.
 * The customer has their own copy of that invoice, and the shop cannot defend
 * the claim — which is precisely what the module says it exists to avoid.
 *
 * The ageing report never had this: `daysOverdue` in `lib/settlements/ageing`
 * truncates to the day and is tested on this very hour. The reminder took a
 * different route to the same question and got a different answer.
 */
describe("what the reminder says on the due date itself", () => {
  /** Half past four in the afternoon UTC, on the day the invoice falls due. */
  function thatAfternoon(): Date {
    const today = new Date();
    return new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate(),
        16,
        30,
      ),
    );
  }

  it("does not call an invoice late on the day it falls due", async () => {
    const shop = await shopWithDebt(0);
    const preview = await reminderPreview({
      companyId: shop.companyId,
      customerId: shop.customerId,
      asOf: thatAfternoon(),
    });

    expect(preview?.invoices).toHaveLength(1);
    expect(preview?.invoices[0]?.daysOverdue).toBe(0);
    expect(preview?.oldestOverdueDays).toBe(0);
    // The figure the subject line and the opening sentence are chosen from.
    expect(Number(preview?.totalOverdue)).toBe(0);
  }, 120_000);

  it("sends a statement rather than a demand", async () => {
    const shop = await shopWithDebt(0);
    const preview = await reminderPreview({
      companyId: shop.companyId,
      customerId: shop.customerId,
      asOf: thatAfternoon(),
    });
    if (!preview) throw new Error("The customer should have been found");

    const email = paymentReminderEmail({
      to: "accounts@sharma.example",
      supplierName: "Remind Mart",
      preview,
    });

    expect(email.subject).toContain("Statement of account");
    expect(email.subject).not.toContain("Payment reminder");
    expect(email.text).toContain("not yet due");
    expect(email.text).not.toContain("past its due date");
  }, 120_000);

  it("calls it a day late the following morning", async () => {
    // The other side of the same boundary: five past midnight is one day, and
    // a fix that simply stopped counting would pass the two cases above.
    const shop = await shopWithDebt(0);
    const today = new Date();
    const preview = await reminderPreview({
      companyId: shop.companyId,
      customerId: shop.customerId,
      asOf: new Date(
        Date.UTC(
          today.getUTCFullYear(),
          today.getUTCMonth(),
          today.getUTCDate() + 1,
          0,
          5,
        ),
      ),
    });

    expect(preview?.invoices[0]?.daysOverdue).toBe(1);
    expect(preview?.oldestOverdueDays).toBe(1);
    expect(Number(preview?.totalOverdue)).toBeGreaterThan(0);
  }, 120_000);
});

describe("one shop's debtors are its own", () => {
  it("will not read a customer that belongs to another company", async () => {
    // Naming another tenant's customer id must find nothing rather than
    // produce their account — this is the query a reminder is built from.
    const [mine, theirs] = await Promise.all([
      shopWithDebt(40),
      shopWithDebt(40),
    ]);

    const crossed = await reminderPreview({
      companyId: mine.companyId,
      customerId: theirs.customerId,
    });
    expect(crossed).toBeNull();
  }, 120_000);

  it("counts only invoices raised by the company asking", async () => {
    const [mine, theirs] = await Promise.all([
      shopWithDebt(40, 250),
      shopWithDebt(40, 9_999),
    ]);

    const mineView = await reminderPreview({
      companyId: mine.companyId,
      customerId: mine.customerId,
    });
    // Both shops have a customer of the same name; the figures must not mix.
    expect(Number(mineView?.totalOutstanding)).toBeLessThan(1_000);
    expect(theirs.companyId).not.toBe(mine.companyId);
  }, 120_000);
});
