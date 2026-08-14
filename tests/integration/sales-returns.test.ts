import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocumentStatus } from "@prisma/client";
import type { RegisterInput } from "@/lib/validation/auth";
import type { CustomerInput, ProductInput } from "@/lib/validation/master-data";
import type { SaleInput } from "@/lib/validation/sales";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale, voidSale } from "@/server/sales/sale-service";
import { getTrialBalance } from "@/server/accounting/trial-balance-service";
import { readPosition } from "@/server/inventory/stock-service";
import {
  createSalesReturn,
  returnableLines,
} from "@/server/returns/sales-return-service";
import { ReturnError } from "@/server/returns/errors";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Sales returns.
 *
 * A return is the first document in this product that reverses another one, and
 * almost everything that can go wrong is a matter of *which* figures it
 * reverses. Returning at today's price misstates revenue; returning at today's
 * average cost invents a profit on goods that only travelled to the customer
 * and back; returning at today's tax rate files the wrong credit note. So the
 * tests here are mostly about provenance, not arithmetic.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

const today = new Date().toISOString().slice(0, 10);

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
      businessName: `Returns ${uniqueSlug("Mart")}`,
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
};

async function createCompany(): Promise<Fixture> {
  const email = `returns-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
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
  // A rate with actual tax on it, so the credit note has something to reverse.
  const rate =
    taxonomy.taxRates.find((entry) => Number(entry.ratePercent) > 0) ??
    taxonomy.taxRates[0];
  if (!unit || !rate) throw new Error("Provisioning is incomplete");

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
      taxRateId: rate.id,
      purchasePrice: 60,
      sellingPrice: 100,
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
      creditLimit: 10_000_000,
      openingBalance: 0,
      openingNature: "DEBIT",
      notes: "",
    } satisfies CustomerInput,
  });

  return { ...base, productId: product.id, customerId: customer.id };
}

async function sell(fixture: Fixture, quantity: number, rate = 100) {
  return createSale({
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
          quantity,
          rate,
          discountPercent: 0,
        },
      ],
    } satisfies SaleInput,
  });
}

/** A posted account, found by the name the chart gives it. */
async function accountNamed(companyId: string, name: RegExp) {
  const trial = await getTrialBalance({ companyId, to: today });
  return (
    trial.sections
      .flatMap((section) => section.rows)
      .find((row) => name.test(row.name)) ?? null
  );
}

beforeAll(async () => {
  await ensurePlatformData();
}, 60_000);

afterAll(async () => {
  for (const companyId of createdCompanies) await purgeTestCompany(companyId);
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
}, 60_000);

describe("a return posts its own accounting", () => {
  it("leaves the books balanced", async () => {
    const fixture = await createCompany();
    const sale = await sell(fixture, 10);
    const lines = await returnableLines({
      companyId: fixture.companyId,
      saleId: sale.id,
    });

    await createSalesReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        saleId: sale.id,
        returnDate: today,
        reason: "Damaged in transit",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: lines[0]!.lineId, quantity: 4 }],
      },
    });

    const trial = await getTrialBalance({
      companyId: fixture.companyId,
      to: today,
    });
    expect(trial.balanced).toBe(true);
  }, 90_000);

  it("records the return as contra-revenue, not as a smaller sale", async () => {
    // Netting a return into the revenue figure hides the return rate, which for
    // a retailer is one of the more diagnostic numbers there is.
    const fixture = await createCompany();
    const sale = await sell(fixture, 10);
    const lines = await returnableLines({
      companyId: fixture.companyId,
      saleId: sale.id,
    });

    await createSalesReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        saleId: sale.id,
        returnDate: today,
        reason: "",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: lines[0]!.lineId, quantity: 4 }],
      },
    });

    const sales = await accountNamed(fixture.companyId, /^Sales$/i);
    const returns = await accountNamed(fixture.companyId, /Sales Return/i);

    // The full sale is still on the Sales account.
    expect(Number(sales?.periodCredit ?? 0)).toBeCloseTo(1000, 2);
    // And the return sits beside it rather than inside it.
    expect(Number(returns?.periodDebit ?? 0)).toBeCloseTo(400, 2);
  }, 90_000);

  it("brings stock back at what it cost, not at today's average", async () => {
    const fixture = await createCompany();
    const before = await readPosition(prisma, {
      companyId: fixture.companyId,
      productId: fixture.productId,
      branchId: null,
      method: "WEIGHTED_AVERAGE",
    });

    const sale = await sell(fixture, 10);
    const lines = await returnableLines({
      companyId: fixture.companyId,
      saleId: sale.id,
    });

    await createSalesReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        saleId: sale.id,
        returnDate: today,
        reason: "",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: lines[0]!.lineId, quantity: 10 }],
      },
    });

    const after = await readPosition(prisma, {
      companyId: fixture.companyId,
      productId: fixture.productId,
      branchId: null,
      method: "WEIGHTED_AVERAGE",
    });

    // Everything sold came back, so the shelf is exactly where it started —
    // in quantity and in value. A return at any other cost would leave the
    // stock value adrift from where it began.
    expect(Number(after.quantity)).toBeCloseTo(Number(before.quantity), 3);
    expect(Number(after.stockValue)).toBeCloseTo(Number(before.stockValue), 2);
  }, 90_000);

  it("reverses the cost of sales, so a full return leaves no margin behind", async () => {
    const fixture = await createCompany();
    const sale = await sell(fixture, 10);
    const lines = await returnableLines({
      companyId: fixture.companyId,
      saleId: sale.id,
    });

    await createSalesReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        saleId: sale.id,
        returnDate: today,
        reason: "",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: lines[0]!.lineId, quantity: 10 }],
      },
    });

    const cogs = await accountNamed(fixture.companyId, /Cost of Goods Sold/i);
    // 10 × 60 out, 10 × 60 back.
    expect(
      Number(cogs?.periodDebit ?? 0) - Number(cogs?.periodCredit ?? 0),
    ).toBeCloseTo(0, 2);
  }, 90_000);

  it("writes the credit note into the GST register as a negative supply", async () => {
    const fixture = await createCompany();
    const sale = await sell(fixture, 10);
    const lines = await returnableLines({
      companyId: fixture.companyId,
      saleId: sale.id,
    });

    await createSalesReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        saleId: sale.id,
        returnDate: today,
        reason: "",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: lines[0]!.lineId, quantity: 4 }],
      },
    });

    const rows = await prisma.gstTransaction.findMany({
      where: { companyId: fixture.companyId, documentType: "SalesReturn" },
    });

    expect(rows.length).toBeGreaterThan(0);
    // Negative rows appended, not the invoice's rows edited: a period somebody
    // has already looked at still shows what was there when they looked.
    expect(Number(rows[0]!.taxableValue)).toBeLessThan(0);
  }, 90_000);
});

describe("what a return refuses to do", () => {
  it("will not return more than was sold", async () => {
    const fixture = await createCompany();
    const sale = await sell(fixture, 5);
    const lines = await returnableLines({
      companyId: fixture.companyId,
      saleId: sale.id,
    });

    await expect(
      createSalesReturn({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        branchId: null,
        input: {
          saleId: sale.id,
          returnDate: today,
          reason: "",
          refundMode: "CREDIT",
          lines: [{ sourceLineId: lines[0]!.lineId, quantity: 6 }],
        },
      }),
    ).rejects.toThrow(ReturnError);
  }, 90_000);

  it("counts what has already come back", async () => {
    // Two returns of three against a sale of five: the second must be refused.
    const fixture = await createCompany();
    const sale = await sell(fixture, 5);
    const lines = await returnableLines({
      companyId: fixture.companyId,
      saleId: sale.id,
    });
    const lineId = lines[0]!.lineId;

    const first = {
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        saleId: sale.id,
        returnDate: today,
        reason: "",
        refundMode: "CREDIT" as const,
        lines: [{ sourceLineId: lineId, quantity: 3 }],
      },
    };

    await createSalesReturn(first);
    await expect(createSalesReturn(first)).rejects.toThrow(/remains/);

    const remaining = await returnableLines({
      companyId: fixture.companyId,
      saleId: sale.id,
    });
    expect(Number(remaining[0]!.returnable)).toBeCloseTo(2, 3);
  }, 90_000);

  it("will not return against a voided invoice", async () => {
    // Voiding already reversed the revenue, the tax and the stock. Returning
    // as well would reverse all three a second time.
    const fixture = await createCompany();
    const sale = await sell(fixture, 5);
    const lines = await returnableLines({
      companyId: fixture.companyId,
      saleId: sale.id,
    });

    await voidSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      saleId: sale.id,
      reason: "Entered twice",
    });

    await expect(
      createSalesReturn({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        branchId: null,
        input: {
          saleId: sale.id,
          returnDate: today,
          reason: "",
          refundMode: "CREDIT",
          lines: [{ sourceLineId: lines[0]!.lineId, quantity: 1 }],
        },
      }),
    ).rejects.toThrow(/voided/i);
  }, 90_000);

  it("will not be dated before the invoice", async () => {
    const fixture = await createCompany();
    const sale = await sell(fixture, 5);
    const lines = await returnableLines({
      companyId: fixture.companyId,
      saleId: sale.id,
    });

    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10);

    await expect(
      createSalesReturn({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        branchId: null,
        input: {
          saleId: sale.id,
          returnDate: yesterday,
          reason: "",
          refundMode: "CREDIT",
          lines: [{ sourceLineId: lines[0]!.lineId, quantity: 1 }],
        },
      }),
    ).rejects.toThrow(/before the invoice/i);
  }, 90_000);

  it("will not touch another company's invoice", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);
    const theirSale = await sell(theirs, 5);
    const lines = await returnableLines({
      companyId: theirs.companyId,
      saleId: theirSale.id,
    });

    await expect(
      createSalesReturn({
        companyId: mine.companyId,
        userId: mine.userId,
        actorEmail: mine.actorEmail,
        branchId: null,
        input: {
          saleId: theirSale.id,
          returnDate: today,
          reason: "",
          refundMode: "CREDIT",
          lines: [{ sourceLineId: lines[0]!.lineId, quantity: 1 }],
        },
      }),
    ).rejects.toThrow(/could not be found/i);
  }, 120_000);

  it("leaves the original invoice untouched", async () => {
    // A return is not an edit. The invoice says what it always said.
    const fixture = await createCompany();
    const sale = await sell(fixture, 10);
    const before = await prisma.sale.findUniqueOrThrow({
      where: { id: sale.id },
      select: { totalAmount: true, status: true, journalEntryId: true },
    });

    const lines = await returnableLines({
      companyId: fixture.companyId,
      saleId: sale.id,
    });
    await createSalesReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        saleId: sale.id,
        returnDate: today,
        reason: "",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: lines[0]!.lineId, quantity: 10 }],
      },
    });

    const after = await prisma.sale.findUniqueOrThrow({
      where: { id: sale.id },
      select: { totalAmount: true, status: true, journalEntryId: true },
    });
    expect(after).toEqual(before);
    expect(after.status).toBe(DocumentStatus.POSTED);
  }, 90_000);
});
