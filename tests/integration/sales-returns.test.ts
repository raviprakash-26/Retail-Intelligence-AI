import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocumentStatus } from "@prisma/client";
import type { RegisterInput } from "@/lib/validation/auth";
import type { CustomerInput, ProductInput } from "@/lib/validation/master-data";
import type { SaleInput } from "@/lib/validation/sales";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale, SaleError, voidSale } from "@/server/sales/sale-service";
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

  it("balances a return whose exact value ends in paise", async () => {
    // ₹49.90 × 3 plus GST does not land on a rupee. The credit note is issued
    // at the whole rupee, like the invoice it reverses, so the fraction has to
    // be posted to Round Off. A service that computes a rounded total and
    // never posts the rounding produces a one-sided entry — and fails here and
    // nowhere else, because every round-figure fixture hides it.
    const fixture = await createCompany();
    const sale = await sell(fixture, 3, 49.9);
    const lines = await returnableLines({
      companyId: fixture.companyId,
      saleId: sale.id,
    });

    const posted = await createSalesReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        saleId: sale.id,
        returnDate: today,
        reason: "",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: lines[0]!.lineId, quantity: 3 }],
      },
    });

    // Credited at a whole rupee, with the fraction accounted for.
    expect(Number(posted.totalAmount) % 1).toBeCloseTo(0, 6);

    const record = await prisma.salesReturn.findUniqueOrThrow({
      where: { id: posted.id },
      select: {
        taxableAmount: true,
        cgstAmount: true,
        sgstAmount: true,
        igstAmount: true,
        roundOff: true,
        totalAmount: true,
      },
    });

    // The rounding is real, and the stored figures reconcile to the paisa.
    expect(Number(record.roundOff)).not.toBe(0);
    expect(
      Number(record.taxableAmount) +
        Number(record.cgstAmount) +
        Number(record.sgstAmount) +
        Number(record.igstAmount) +
        Number(record.roundOff),
    ).toBeCloseTo(Number(record.totalAmount), 4);

    const trial = await getTrialBalance({
      companyId: fixture.companyId,
      to: today,
    });
    expect(trial.balanced).toBe(true);
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

  it("refuses a line named twice in the same return", async () => {
    // Three and three against a sale of five. Neither exceeds what is
    // outstanding on its own and the guard never adds them up, so it passes
    // both — and the only thing that stops six of five coming back is a unique
    // constraint on the return's line numbers, which fails as a raw database
    // error rather than as a refusal anybody can read.
    const fixture = await createCompany();
    const sale = await sell(fixture, 5);
    const lines = await returnableLines({
      companyId: fixture.companyId,
      saleId: sale.id,
    });
    const lineId = lines[0]!.lineId;

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
          lines: [
            { sourceLineId: lineId, quantity: 3 },
            { sourceLineId: lineId, quantity: 3 },
          ],
        },
      }),
    ).rejects.toThrow(ReturnError);

    // Nothing came back, so the whole five is still returnable.
    const after = await returnableLines({
      companyId: fixture.companyId,
      saleId: sale.id,
    });
    expect(Number(after[0]!.returnable)).toBeCloseTo(5, 3);
  }, 90_000);

  it("refuses a repeated line even when the two together fit", async () => {
    // Two and two of five is within what is owed, and still refused. A return
    // item carries the invoice's line number so a later return can tell which
    // line it is drawing down, which leaves room for exactly one item per
    // invoice line — there is nowhere to put the second. Merging them would
    // mean quietly rewriting a request rather than answering it, so this says
    // no in the same words the allocation guard uses for a document named
    // twice.
    const fixture = await createCompany();
    const sale = await sell(fixture, 5);
    const lines = await returnableLines({
      companyId: fixture.companyId,
      saleId: sale.id,
    });
    const lineId = lines[0]!.lineId;

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
          lines: [
            { sourceLineId: lineId, quantity: 2 },
            { sourceLineId: lineId, quantity: 2 },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_LINE" });

    const after = await returnableLines({
      companyId: fixture.companyId,
      saleId: sale.id,
    });
    expect(Number(after[0]!.returnable)).toBeCloseTo(5, 3);
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

  /**
   * The same rule read from the other end.
   *
   * The refusal above was written and the mirror of it was not, so an invoice
   * that had been partly credited back could still be voided — and a void
   * reverses the whole invoice. On a sale of ten with four returned, the books
   * ended up holding four units of stock the shop never had, four hundred
   * rupees of negative revenue against a cancelled sale, a customer apparently
   * owed money, and a credit note in the GST register belonging to an invoice
   * that no longer existed.
   */
  it("will not void an invoice that has already been returned against", async () => {
    const fixture = await createCompany();
    const sale = await sell(fixture, 10);
    const lines = await returnableLines({
      companyId: fixture.companyId,
      saleId: sale.id,
    });

    const credited = await createSalesReturn({
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

    const attempt = voidSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      saleId: sale.id,
      reason: "Entered twice",
    });

    await expect(attempt).rejects.toMatchObject({ code: "ALREADY_RETURNED" });
    // Named, so the shop can go and look at the credit note in question, and
    // told what to do instead — the void is refused, not the correction.
    await expect(attempt).rejects.toThrow(
      new RegExp(`${credited.returnNumber}[\\s\\S]*record a return`, "i"),
    );
  }, 90_000);

  it("leaves the books untouched when that void is refused", async () => {
    // The defect stated as a figure: stock drifted by exactly the returned
    // quantity, because the return put four back and the void put ten back.
    const fixture = await createCompany();

    const onHand = async () => {
      const last = await prisma.inventoryMovement.findFirst({
        where: { companyId: fixture.companyId, productId: fixture.productId },
        orderBy: [{ movementDate: "desc" }, { createdAt: "desc" }],
        select: { balanceQuantity: true },
      });
      return Number(last?.balanceQuantity ?? 0);
    };

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

    const before = await onHand();
    await expect(
      voidSale({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        saleId: sale.id,
        reason: "Entered twice",
      }),
    ).rejects.toThrow(SaleError);

    expect(await onHand()).toBeCloseTo(before, 3);
    const still = await prisma.sale.findUniqueOrThrow({
      where: { id: sale.id },
      select: { status: true },
    });
    expect(still.status).toBe(DocumentStatus.POSTED);
  }, 90_000);

  it("still voids an invoice nothing has come back against", async () => {
    // The ordinary void, which the new guard must not have caught up in it.
    const fixture = await createCompany();
    const sale = await sell(fixture, 10);

    await voidSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      saleId: sale.id,
      reason: "Entered twice",
    });

    const voided = await prisma.sale.findUniqueOrThrow({
      where: { id: sale.id },
      select: { status: true },
    });
    expect(voided.status).toBe(DocumentStatus.VOIDED);
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
