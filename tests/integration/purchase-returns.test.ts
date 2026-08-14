import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocumentStatus } from "@prisma/client";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { trialBalanceIsBalanced } from "@/lib/accounting/double-entry";
import { subtract, toStorageString } from "@/lib/money";
import type { RegisterInput } from "@/lib/validation/auth";
import type { ProductInput, SupplierInput } from "@/lib/validation/master-data";
import type { PurchaseInput } from "@/lib/validation/purchases";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import {
  createPurchase,
  voidPurchase,
} from "@/server/purchases/purchase-service";
import {
  createPurchaseReturn,
  returnableBillLines,
} from "@/server/returns/purchase-return-service";
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
 * Purchase returns — a debit note to a supplier.
 *
 * Where a sales return only has to reverse figures the invoice already carried,
 * a purchase return has to reconcile two numbers that genuinely disagree: what
 * the supplier refunds (the price on the bill) and what leaves the shelf (what
 * the valuation method says the goods are worth today). Most of what follows is
 * about that gap being recognised rather than quietly absorbed into stock.
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
      businessName: `Debit Note ${uniqueSlug("Mart")}`,
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
  supplierId: string;
};

async function createCompany(): Promise<Fixture> {
  const email = `pret-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
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
  // A rate with tax actually on it, so the debit note has credit to reverse.
  const gst18 = taxonomy.taxRates.find((entry) => entry.code === "GST18");
  if (!unit || !gst18) throw new Error("Provisioning is incomplete");

  const product = await createProduct({
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
      purchasePrice: 100,
      sellingPrice: 150,
      mrp: 0,
      isStockTracked: true,
      openingQuantity: 0,
      openingRate: 0,
      minStockLevel: 0,
    } satisfies ProductInput,
  });

  const supplier = await createParty({
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
  });

  return { ...base, productId: product.id, supplierId: supplier.id };
}

async function buy(fixture: Fixture, quantity: number, rate = 100) {
  return createPurchase({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      supplierId: fixture.supplierId,
      supplierBillNo: "",
      billDate: today,
      paymentMode: "CREDIT",
      priceIncludesTax: false,
      claimInputCredit: true,
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
    } satisfies PurchaseInput,
  });
}

/** Net debit on a system account. Credit-natured accounts read negative. */
async function accountBalance(
  companyId: string,
  systemKey: string,
): Promise<string> {
  const account = await prisma.account.findFirstOrThrow({
    where: { companyId, systemKey },
    select: { id: true },
  });
  const totals = await prisma.journalLine.aggregate({
    where: { companyId, accountId: account.id, status: "POSTED" },
    _sum: { debit: true, credit: true },
  });
  return toStorageString(
    subtract(totals._sum.debit ?? 0, totals._sum.credit ?? 0),
  );
}

async function assertTrialBalances(companyId: string): Promise<void> {
  const lines = await prisma.journalLine.groupBy({
    by: ["accountId"],
    where: { companyId, status: "POSTED" },
    _sum: { debit: true, credit: true },
  });
  const trial = trialBalanceIsBalanced(
    lines.map((line) => ({
      debit: line._sum.debit ?? 0,
      credit: line._sum.credit ?? 0,
    })),
  );
  expect(trial.difference.toString()).toBe("0");
}

/** The first returnable line on a bill. Every fixture bill has exactly one. */
async function firstLine(fixture: Fixture, purchaseId: string) {
  const lines = await returnableBillLines({
    companyId: fixture.companyId,
    purchaseId,
  });
  const line = lines[0];
  if (!line) throw new Error("The bill has no returnable lines");
  return line;
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

describe("a debit note posts its own accounting", () => {
  it("leaves the books balanced", async () => {
    const fixture = await createCompany();
    const bill = await buy(fixture, 10);
    const line = await firstLine(fixture, bill.id);

    await createPurchaseReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        purchaseId: bill.id,
        returnDate: today,
        reason: "Short shipped",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: line.lineId, quantity: 4 }],
      },
    });

    await assertTrialBalances(fixture.companyId);
  }, 90_000);

  it("takes the goods off the balance sheet rather than booking income", async () => {
    // Under perpetual inventory a purchase was never an expense — it was a
    // debit to stock. So returning it credits stock. Crediting a "purchase
    // returns" income account instead would leave the balance sheet carrying
    // goods that are physically back with the supplier.
    const fixture = await createCompany();
    const bill = await buy(fixture, 10);
    const line = await firstLine(fixture, bill.id);

    await createPurchaseReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        purchaseId: bill.id,
        returnDate: today,
        reason: "",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: line.lineId, quantity: 4 }],
      },
    });

    // ₹1,000 in, ₹400 back out.
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.INVENTORY),
    ).toBe(toStorageString(600));
    // And the shelf agrees with the ledger.
    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { companyId: fixture.companyId, productId: fixture.productId },
      select: { quantity: true, stockValue: true },
    });
    expect(toStorageString(balance.quantity)).toBe(toStorageString(6));
    expect(toStorageString(balance.stockValue)).toBe(toStorageString(600));
  }, 90_000);

  it("gives back the input credit claimed on goods that went back", async () => {
    const fixture = await createCompany();
    const bill = await buy(fixture, 10);
    const line = await firstLine(fixture, bill.id);

    await createPurchaseReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        purchaseId: bill.id,
        returnDate: today,
        reason: "",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: line.lineId, quantity: 4 }],
      },
    });

    // 18% on ₹1,000 was ₹90 + ₹90; 18% on the ₹400 returned is ₹36 + ₹36.
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.GST_INPUT_CGST),
    ).toBe(toStorageString(54));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.GST_INPUT_SGST),
    ).toBe(toStorageString(54));
    // The supplier is owed ₹1,180 less the ₹472 gone back.
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE),
    ).toBe(toStorageString(-708));
  }, 90_000);

  it("recognises the gap between what the shelf gives up and what the supplier refunds", async () => {
    // Two bills at different prices move the weighted average. The supplier
    // still refunds the price on *their* bill, but the goods leave at the
    // average — and the difference is a real cost that has to be named rather
    // than left inflating the value of stock that is no longer there.
    const fixture = await createCompany();
    const first = await buy(fixture, 10, 100);
    await buy(fixture, 10, 120);
    const line = await firstLine(fixture, first.id);

    const posted = await createPurchaseReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        purchaseId: first.id,
        returnDate: today,
        reason: "Wrong specification",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: line.lineId, quantity: 10 }],
      },
    });

    // Refunded at the bill: ₹1,000 + ₹180 tax.
    expect(posted.totalAmount).toBe(toStorageString(1180));
    // Removed at the average of ₹110.
    expect(posted.stockValueRemoved).toBe(toStorageString(1100));
    // The ₹100 between them lands in the trading account, not in stock.
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.DIRECT_EXPENSES),
    ).toBe(toStorageString(100));

    // Stock left: 10 units of the second bill, carried at the same average.
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.INVENTORY),
    ).toBe(toStorageString(1100));
    await assertTrialBalances(fixture.companyId);
  }, 120_000);

  it("balances a return whose exact value ends in paise", async () => {
    // ₹49.90 × 3 at 18% does not land on a rupee. The debit note is raised for
    // the whole rupee the supplier will credit, so the fraction has to be
    // posted. Every other fixture here uses round figures, which is precisely
    // why this case needs its own test.
    const fixture = await createCompany();
    const bill = await buy(fixture, 3, 49.9);
    const line = await firstLine(fixture, bill.id);

    const posted = await createPurchaseReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        purchaseId: bill.id,
        returnDate: today,
        reason: "",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: line.lineId, quantity: 3 }],
      },
    });

    expect(Number(posted.totalAmount) % 1).toBeCloseTo(0, 6);

    const record = await prisma.purchaseReturn.findUniqueOrThrow({
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

    expect(Number(record.roundOff)).not.toBe(0);
    expect(
      Number(record.taxableAmount) +
        Number(record.cgstAmount) +
        Number(record.sgstAmount) +
        Number(record.igstAmount) +
        Number(record.roundOff),
    ).toBeCloseTo(Number(record.totalAmount), 4);

    await assertTrialBalances(fixture.companyId);
  }, 90_000);

  it("writes the debit note into the GST register as a negative inward supply", async () => {
    const fixture = await createCompany();
    const bill = await buy(fixture, 10);
    const line = await firstLine(fixture, bill.id);

    await createPurchaseReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        purchaseId: bill.id,
        returnDate: today,
        reason: "",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: line.lineId, quantity: 4 }],
      },
    });

    const rows = await prisma.gstTransaction.findMany({
      where: { companyId: fixture.companyId, documentType: "PurchaseReturn" },
    });

    expect(rows.length).toBeGreaterThan(0);
    // Appended as negatives rather than editing the bill's rows, so a period
    // somebody has already reviewed still shows what was there when they did.
    expect(Number(rows[0]!.taxableValue)).toBeLessThan(0);
    expect(rows[0]!.direction).toBe("INWARD");
  }, 90_000);

  it("takes the refund out of the till when the supplier pays cash back", async () => {
    const fixture = await createCompany();
    const bill = await buy(fixture, 10);
    const line = await firstLine(fixture, bill.id);

    const cashBefore = await accountBalance(
      fixture.companyId,
      SYSTEM_ACCOUNT.CASH,
    );

    await createPurchaseReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        purchaseId: bill.id,
        returnDate: today,
        reason: "",
        refundMode: "CASH",
        lines: [{ sourceLineId: line.lineId, quantity: 4 }],
      },
    });

    // Cash comes in; what the supplier is owed is untouched.
    expect(await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.CASH)).toBe(
      toStorageString(Number(cashBefore) + 472),
    );
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE),
    ).toBe(toStorageString(-1180));
  }, 90_000);
});

describe("what a debit note refuses to do", () => {
  it("will not return more than was bought", async () => {
    const fixture = await createCompany();
    const bill = await buy(fixture, 5);
    const line = await firstLine(fixture, bill.id);

    await expect(
      createPurchaseReturn({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        branchId: null,
        input: {
          purchaseId: bill.id,
          returnDate: today,
          reason: "",
          refundMode: "CREDIT",
          lines: [{ sourceLineId: line.lineId, quantity: 6 }],
        },
      }),
    ).rejects.toThrow(ReturnError);
  }, 90_000);

  it("counts what has already gone back", async () => {
    // Two returns of three against a bill of five: the second must be refused.
    const fixture = await createCompany();
    const bill = await buy(fixture, 5);
    const line = await firstLine(fixture, bill.id);

    const attempt = {
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        purchaseId: bill.id,
        returnDate: today,
        reason: "",
        refundMode: "CREDIT" as const,
        lines: [{ sourceLineId: line.lineId, quantity: 3 }],
      },
    };

    await createPurchaseReturn(attempt);
    await expect(createPurchaseReturn(attempt)).rejects.toThrow(/remains/);

    const remaining = await firstLine(fixture, bill.id);
    expect(Number(remaining.returnable)).toBeCloseTo(2, 3);
    expect(Number(remaining.alreadyReturned)).toBeCloseTo(3, 3);
  }, 90_000);

  it("will not return against a voided bill", async () => {
    // Voiding already reversed the stock and the input credit. Returning as
    // well would reverse both a second time.
    const fixture = await createCompany();
    const bill = await buy(fixture, 5);
    const line = await firstLine(fixture, bill.id);

    await voidPurchase({
      companyId: fixture.companyId,
      purchaseId: bill.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      reason: "Goods never arrived",
    });

    await expect(
      createPurchaseReturn({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        branchId: null,
        input: {
          purchaseId: bill.id,
          returnDate: today,
          reason: "",
          refundMode: "CREDIT",
          lines: [{ sourceLineId: line.lineId, quantity: 1 }],
        },
      }),
    ).rejects.toThrow(/voided/i);
  }, 90_000);

  it("will not be dated before the bill", async () => {
    const fixture = await createCompany();
    const bill = await buy(fixture, 5);
    const line = await firstLine(fixture, bill.id);

    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10);

    await expect(
      createPurchaseReturn({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        branchId: null,
        input: {
          purchaseId: bill.id,
          returnDate: yesterday,
          reason: "",
          refundMode: "CREDIT",
          lines: [{ sourceLineId: line.lineId, quantity: 1 }],
        },
      }),
    ).rejects.toThrow(/before the bill/i);
  }, 90_000);

  it("will not touch another company's bill", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);
    const theirBill = await buy(theirs, 5);
    const line = await firstLine(theirs, theirBill.id);

    await expect(
      createPurchaseReturn({
        companyId: mine.companyId,
        userId: mine.userId,
        actorEmail: mine.actorEmail,
        branchId: null,
        input: {
          purchaseId: theirBill.id,
          returnDate: today,
          reason: "",
          refundMode: "CREDIT",
          lines: [{ sourceLineId: line.lineId, quantity: 1 }],
        },
      }),
    ).rejects.toThrow(/could not be found/i);

    // And nothing of theirs moved.
    expect(
      await accountBalance(theirs.companyId, SYSTEM_ACCOUNT.INVENTORY),
    ).toBe(toStorageString(500));
  }, 120_000);

  it("leaves the original bill untouched", async () => {
    // A return is not an edit. The bill says what it always said.
    const fixture = await createCompany();
    const bill = await buy(fixture, 10);
    const before = await prisma.purchase.findUniqueOrThrow({
      where: { id: bill.id },
      select: { totalAmount: true, status: true, journalEntryId: true },
    });

    const line = await firstLine(fixture, bill.id);
    await createPurchaseReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        purchaseId: bill.id,
        returnDate: today,
        reason: "",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: line.lineId, quantity: 10 }],
      },
    });

    const after = await prisma.purchase.findUniqueOrThrow({
      where: { id: bill.id },
      select: { totalAmount: true, status: true, journalEntryId: true },
    });
    expect(after).toEqual(before);
    expect(after.status).toBe(DocumentStatus.POSTED);
  }, 90_000);
});
