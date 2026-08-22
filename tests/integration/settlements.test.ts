import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { trialBalanceIsBalanced } from "@/lib/accounting/double-entry";
import { subtract, toStorageString } from "@/lib/money";
import type { RegisterInput } from "@/lib/validation/auth";
import type {
  CustomerInput,
  ProductInput,
  SupplierInput,
} from "@/lib/validation/master-data";
import type { PurchaseInput } from "@/lib/validation/purchases";
import type { SaleInput } from "@/lib/validation/sales";
import type { PaymentInput, ReceiptInput } from "@/lib/validation/settlements";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import {
  createPurchase,
  listPurchases,
} from "@/server/purchases/purchase-service";
import { createSale, listSales } from "@/server/sales/sale-service";
import {
  openBills,
  openInvoices,
  payablesAgeing,
  receivablesAgeing,
} from "@/server/settlements/outstanding";
import {
  createPayment,
  createReceipt,
  getReceipt,
  listPayments,
  listReceipts,
  voidPayment,
  voidReceipt,
  SettlementError,
} from "@/server/settlements/settlement-service";
import {
  createSalesReturn,
  returnableLines,
} from "@/server/returns/sales-return-service";
import {
  createPurchaseReturn,
  returnableBillLines,
} from "@/server/returns/purchase-return-service";
import {
  ledgerParties,
  partyStatement,
} from "@/server/accounting/ledger-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Receipts and payments.
 *
 * The behaviour worth protecting is not "money moves" — it is that the control
 * account moves by the full amount whether or not anyone said which invoice it
 * settled, that an allocation can never exceed what a document owes, and that
 * voiding a receipt puts the invoice it cleared back into the ageing report.
 * Each of those is a way a real ledger silently goes wrong.
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
      businessName: "Settlement Test Mart",
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
      openingCashBalance: 0,
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
  supplierId: string;
};

async function createCompany(): Promise<Fixture> {
  const email = `settle-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);

  const taxonomy = await getProductTaxonomy(result.companyId);
  const unit = taxonomy.units.find((entry) => entry.code === "PCS");
  const gst18 = taxonomy.taxRates.find((entry) => entry.code === "GST18");
  if (!unit || !gst18) throw new Error("Provisioning is incomplete");

  const base = {
    companyId: result.companyId,
    userId: result.userId,
    actorEmail: "owner@example.com",
  };

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
      stateCode: "",
      pincode: "",
      creditDays: 30,
      creditLimit: 500000,
      openingBalance: 0,
      openingNature: "DEBIT",
      notes: "",
    } satisfies CustomerInput,
  });

  const supplier = await createParty({
    ...base,
    kind: "SUPPLIER",
    input: {
      name: "Metro Wholesale",
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

  return {
    ...base,
    productId: product.id,
    customerId: customer.id,
    supplierId: supplier.id,
  };
}

/** A credit invoice. ₹100 × qty at 18% GST. */
async function raiseInvoice(
  fixture: Fixture,
  overrides: Partial<SaleInput> = {},
) {
  return createSale({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      customerId: fixture.customerId,
      invoiceDate: new Date().toISOString().slice(0, 10),
      paymentMode: "CREDIT",
      placeOfSupply: "",
      priceIncludesTax: false,
      notes: "",
      lines: [
        {
          productId: fixture.productId,
          description: "",
          quantity: 10,
          rate: 100,
          discountPercent: 0,
        },
      ],
      ...overrides,
    } satisfies SaleInput,
  });
}

async function raiseBill(
  fixture: Fixture,
  overrides: Partial<PurchaseInput> = {},
) {
  return createPurchase({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      supplierId: fixture.supplierId,
      supplierBillNo: uniqueSlug("SB").toUpperCase(),
      billDate: new Date().toISOString().slice(0, 10),
      paymentMode: "CREDIT",
      priceIncludesTax: false,
      claimInputCredit: true,
      notes: "",
      lines: [
        {
          productId: fixture.productId,
          description: "",
          quantity: 10,
          rate: 100,
          discountPercent: 0,
        },
      ],
      ...overrides,
    } satisfies PurchaseInput,
  });
}

function receiptInput(overrides: Partial<ReceiptInput> = {}): ReceiptInput {
  return {
    kind: "CUSTOMER",
    partyId: "",
    date: new Date().toISOString().slice(0, 10),
    paymentMode: "CASH",
    amount: 1000,
    referenceNo: "",
    notes: "",
    allocations: [],
    ...overrides,
  };
}

function paymentInput(overrides: Partial<PaymentInput> = {}): PaymentInput {
  return {
    kind: "SUPPLIER",
    partyId: "",
    date: new Date().toISOString().slice(0, 10),
    paymentMode: "BANK",
    amount: 1000,
    referenceNo: "",
    notes: "",
    allocations: [],
    ...overrides,
  };
}

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

describe("receiving money from a customer", () => {
  it("clears the invoice it is allocated to and balances", async () => {
    const fixture = await createCompany();
    const sale = await raiseInvoice(fixture);

    // ₹1,000 of goods at 18% = ₹1,180 receivable.
    expect(sale.totalAmount).toBe(toStorageString(1180));
    expect(
      await accountBalance(
        fixture.companyId,
        SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
      ),
    ).toBe(toStorageString(1180));

    const receipt = await createReceipt({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: receiptInput({
        partyId: fixture.customerId,
        amount: 1180,
        allocations: [{ documentId: sale.id, amount: 1180 }],
      }),
    });

    expect(receipt.allocated).toBe(toStorageString(1180));
    expect(receipt.unallocated).toBe(toStorageString(0));

    expect(await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.CASH)).toBe(
      toStorageString(1180),
    );
    expect(
      await accountBalance(
        fixture.companyId,
        SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
      ),
    ).toBe(toStorageString(0));

    // The invoice itself knows it is settled, which is what ageing reads.
    const settled = await prisma.sale.findUniqueOrThrow({
      where: { id: sale.id },
      select: { paidAmount: true },
    });
    expect(toStorageString(settled.paidAmount)).toBe(toStorageString(1180));

    expect(
      await openInvoices(prisma, {
        companyId: fixture.companyId,
        customerId: fixture.customerId,
      }),
    ).toHaveLength(0);

    await assertTrialBalances(fixture.companyId);
  });

  it("moves the control account in full even when nothing is allocated", async () => {
    const fixture = await createCompany();
    await raiseInvoice(fixture);

    const receipt = await createReceipt({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: receiptInput({ partyId: fixture.customerId, amount: 500 }),
    });

    expect(receipt.allocated).toBe(toStorageString(0));
    expect(receipt.unallocated).toBe(toStorageString(500));

    // Receivables fall by the whole ₹500. Which invoice it was against is a
    // sub-ledger question; the ledger position is not in doubt.
    expect(
      await accountBalance(
        fixture.companyId,
        SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
      ),
    ).toBe(toStorageString(680));

    // The invoice, however, is still fully open — nobody said this paid it.
    const open = await openInvoices(prisma, {
      companyId: fixture.companyId,
      customerId: fixture.customerId,
    });
    expect(open).toHaveLength(1);
    expect(open[0]?.outstanding).toBe(toStorageString(1180));

    await assertTrialBalances(fixture.companyId);
  });

  it("part-settles an invoice and leaves the rest outstanding", async () => {
    const fixture = await createCompany();
    const sale = await raiseInvoice(fixture);

    await createReceipt({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: receiptInput({
        partyId: fixture.customerId,
        amount: 500,
        allocations: [{ documentId: sale.id, amount: 500 }],
      }),
    });

    const open = await openInvoices(prisma, {
      companyId: fixture.companyId,
      customerId: fixture.customerId,
    });
    expect(open).toHaveLength(1);
    expect(open[0]?.outstanding).toBe(toStorageString(680));
  });

  it("posts capital introduced to equity, not to income", async () => {
    const fixture = await createCompany();

    // Opening stock is itself capital the owner put in, so the account is not
    // at zero when the fixture is built. The change is what this test is about.
    const before = await accountBalance(
      fixture.companyId,
      SYSTEM_ACCOUNT.OWNER_CAPITAL,
    );

    await createReceipt({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: receiptInput({ kind: "CAPITAL", partyId: "", amount: 50_000 }),
    });

    // Owner's capital is a credit balance, so the net debit moves down.
    const after = await accountBalance(
      fixture.companyId,
      SYSTEM_ACCOUNT.OWNER_CAPITAL,
    );
    expect(toStorageString(subtract(after, before))).toBe(
      toStorageString(-50_000),
    );
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.OTHER_INCOME),
    ).toBe(toStorageString(0));
    expect(
      await accountBalance(
        fixture.companyId,
        SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
      ),
    ).toBe(toStorageString(0));

    await assertTrialBalances(fixture.companyId);
  });

  it("posts a loan received as a liability", async () => {
    const fixture = await createCompany();

    await createReceipt({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: receiptInput({
        kind: "LOAN",
        partyId: "",
        paymentMode: "BANK",
        amount: 200_000,
      }),
    });

    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.LOANS_PAYABLE),
    ).toBe(toStorageString(-200_000));
    expect(await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.BANK)).toBe(
      toStorageString(200_000),
    );
  });

  it("refuses to allocate more than an invoice owes", async () => {
    const fixture = await createCompany();
    const sale = await raiseInvoice(fixture);

    await expect(
      createReceipt({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        input: receiptInput({
          partyId: fixture.customerId,
          amount: 5000,
          allocations: [{ documentId: sale.id, amount: 5000 }],
        }),
      }),
    ).rejects.toThrow(SettlementError);

    // Nothing was written: the whole posting is one transaction.
    const result = await listReceipts({ companyId: fixture.companyId });
    expect(result.total).toBe(0);
    expect(
      await accountBalance(
        fixture.companyId,
        SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
      ),
    ).toBe(toStorageString(1180));
  });

  it("refuses to allocate more than was received", async () => {
    const fixture = await createCompany();
    const first = await raiseInvoice(fixture);
    const second = await raiseInvoice(fixture);

    await expect(
      createReceipt({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        input: receiptInput({
          partyId: fixture.customerId,
          amount: 1500,
          allocations: [
            { documentId: first.id, amount: 1180 },
            { documentId: second.id, amount: 1180 },
          ],
        }),
      }),
    ).rejects.toThrow(/allocated but only/i);
  });

  it("refuses the same invoice twice in one receipt", async () => {
    const fixture = await createCompany();
    const sale = await raiseInvoice(fixture);

    await expect(
      createReceipt({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        input: receiptInput({
          partyId: fixture.customerId,
          amount: 1000,
          allocations: [
            { documentId: sale.id, amount: 500 },
            { documentId: sale.id, amount: 500 },
          ],
        }),
      }),
    ).rejects.toThrow(/twice/i);
  });

  it("will not settle another company's invoice", async () => {
    const alpha = await createCompany();
    const beta = await createCompany();
    const theirs = await raiseInvoice(beta);

    await expect(
      createReceipt({
        companyId: alpha.companyId,
        userId: alpha.userId,
        actorEmail: alpha.actorEmail,
        input: receiptInput({
          partyId: alpha.customerId,
          amount: 1180,
          allocations: [{ documentId: theirs.id, amount: 1180 }],
        }),
      }),
    ).rejects.toThrow(SettlementError);

    // Beta's invoice is untouched.
    const untouched = await prisma.sale.findUniqueOrThrow({
      where: { id: theirs.id },
      select: { paidAmount: true },
    });
    expect(toStorageString(untouched.paidAmount)).toBe(toStorageString(0));
  });

  it("will not accept a customer belonging to another company", async () => {
    const alpha = await createCompany();
    const beta = await createCompany();

    await expect(
      createReceipt({
        companyId: alpha.companyId,
        userId: alpha.userId,
        actorEmail: alpha.actorEmail,
        input: receiptInput({ partyId: beta.customerId, amount: 100 }),
      }),
    ).rejects.toThrow(/could not be found/i);
  });
});

describe("paying a supplier", () => {
  it("clears the bill it is allocated to and balances", async () => {
    const fixture = await createCompany();
    const bill = await raiseBill(fixture);

    expect(bill.totalAmount).toBe(toStorageString(1180));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE),
    ).toBe(toStorageString(-1180));

    await createPayment({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: paymentInput({
        partyId: fixture.supplierId,
        amount: 1180,
        allocations: [{ documentId: bill.id, amount: 1180 }],
      }),
    });

    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE),
    ).toBe(toStorageString(0));
    expect(await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.BANK)).toBe(
      toStorageString(-1180),
    );

    expect(
      await openBills(prisma, {
        companyId: fixture.companyId,
        supplierId: fixture.supplierId,
      }),
    ).toHaveLength(0);

    await assertTrialBalances(fixture.companyId);
  });

  it("treats money the owner takes out as drawings, not an expense", async () => {
    const fixture = await createCompany();

    await createPayment({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: paymentInput({
        kind: "DRAWINGS",
        partyId: "",
        paymentMode: "CASH",
        amount: 15_000,
      }),
    });

    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.DRAWINGS),
    ).toBe(toStorageString(15_000));
    expect(
      await accountBalance(
        fixture.companyId,
        SYSTEM_ACCOUNT.MISCELLANEOUS_EXPENSE,
      ),
    ).toBe(toStorageString(0));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE),
    ).toBe(toStorageString(0));
  });

  it("reduces the liability when a loan is repaid", async () => {
    const fixture = await createCompany();

    await createReceipt({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: receiptInput({
        kind: "LOAN",
        partyId: "",
        paymentMode: "BANK",
        amount: 100_000,
      }),
    });
    await createPayment({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: paymentInput({
        kind: "LOAN_REPAYMENT",
        partyId: "",
        amount: 30_000,
      }),
    });

    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.LOANS_PAYABLE),
    ).toBe(toStorageString(-70_000));

    await assertTrialBalances(fixture.companyId);
  });

  it("refuses to pay a bill belonging to another supplier", async () => {
    const fixture = await createCompany();
    const bill = await raiseBill(fixture);
    const other = await createParty({
      companyId: fixture.companyId,
      kind: "SUPPLIER",
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        name: "Different Wholesaler",
        phone: "",
        email: "",
        gstin: "",
        pan: "",
        addressLine1: "",
        city: "",
        stateCode: "29",
        pincode: "",
        creditDays: 0,
        openingBalance: 0,
        openingNature: "CREDIT",
        notes: "",
      } satisfies SupplierInput,
    });

    await expect(
      createPayment({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        input: paymentInput({
          partyId: other.id,
          amount: 1180,
          allocations: [{ documentId: bill.id, amount: 1180 }],
        }),
      }),
    ).rejects.toThrow(SettlementError);
  });
});

describe("voiding a settlement", () => {
  it("reverses the entry and puts the invoice back into the ageing", async () => {
    const fixture = await createCompany();
    const sale = await raiseInvoice(fixture);

    const receipt = await createReceipt({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: receiptInput({
        partyId: fixture.customerId,
        amount: 1180,
        allocations: [{ documentId: sale.id, amount: 1180 }],
      }),
    });

    await voidReceipt({
      companyId: fixture.companyId,
      receiptId: receipt.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      reason: "Cheque bounced",
    });

    // Cash is back where it was and the debt is owed again.
    expect(await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.CASH)).toBe(
      toStorageString(0),
    );
    expect(
      await accountBalance(
        fixture.companyId,
        SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
      ),
    ).toBe(toStorageString(1180));

    const restored = await prisma.sale.findUniqueOrThrow({
      where: { id: sale.id },
      select: { paidAmount: true },
    });
    expect(toStorageString(restored.paidAmount)).toBe(toStorageString(0));

    const open = await openInvoices(prisma, {
      companyId: fixture.companyId,
      customerId: fixture.customerId,
    });
    expect(open).toHaveLength(1);
    expect(open[0]?.outstanding).toBe(toStorageString(1180));

    await assertTrialBalances(fixture.companyId);
  });

  it("keeps the original entry and posts a reversal beside it", async () => {
    const fixture = await createCompany();
    const receipt = await createReceipt({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: receiptInput({ kind: "CAPITAL", partyId: "", amount: 9000 }),
    });

    await voidReceipt({
      companyId: fixture.companyId,
      receiptId: receipt.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      reason: "Entered against the wrong business",
    });

    const detail = await getReceipt({
      companyId: fixture.companyId,
      receiptId: receipt.id,
    });
    expect(detail.receipt.status).toBe("VOIDED");
    expect(detail.receipt.voidReason).toBe(
      "Entered against the wrong business",
    );
    // The original is marked reversed but its lines are untouched.
    expect(detail.entry?.entryNumber).toBe(receipt.entryNumber);
    expect(detail.entry?.status).toBe("REVERSED");

    const entries = await prisma.journalEntry.count({
      where: { companyId: fixture.companyId, sourceId: receipt.id },
    });
    expect(entries).toBe(2);
  });

  it("refuses to void the same receipt twice", async () => {
    const fixture = await createCompany();
    const receipt = await createReceipt({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: receiptInput({ kind: "OTHER_INCOME", partyId: "", amount: 250 }),
    });

    const args = {
      companyId: fixture.companyId,
      receiptId: receipt.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      reason: "Duplicate entry",
    };
    await voidReceipt(args);
    await expect(voidReceipt(args)).rejects.toThrow(/already been voided/i);
  });

  it("restores what is owed to a supplier when a payment is voided", async () => {
    const fixture = await createCompany();
    const bill = await raiseBill(fixture);

    const payment = await createPayment({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: paymentInput({
        partyId: fixture.supplierId,
        amount: 1180,
        allocations: [{ documentId: bill.id, amount: 1180 }],
      }),
    });

    await voidPayment({
      companyId: fixture.companyId,
      paymentId: payment.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      reason: "Paid the wrong supplier",
    });

    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE),
    ).toBe(toStorageString(-1180));
    expect(await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.BANK)).toBe(
      toStorageString(0),
    );

    const open = await openBills(prisma, {
      companyId: fixture.companyId,
      supplierId: fixture.supplierId,
    });
    expect(open).toHaveLength(1);

    await assertTrialBalances(fixture.companyId);
  });

  it("will not void another company's receipt", async () => {
    const alpha = await createCompany();
    const beta = await createCompany();

    const theirs = await createReceipt({
      companyId: beta.companyId,
      userId: beta.userId,
      actorEmail: beta.actorEmail,
      input: receiptInput({ kind: "CAPITAL", partyId: "", amount: 1000 }),
    });

    await expect(
      voidReceipt({
        companyId: alpha.companyId,
        receiptId: theirs.id,
        userId: alpha.userId,
        actorEmail: alpha.actorEmail,
        reason: "Should not be possible",
      }),
    ).rejects.toThrow(/could not be found/i);

    const untouched = await prisma.receipt.findUniqueOrThrow({
      where: { id: theirs.id },
      select: { status: true },
    });
    expect(untouched.status).toBe("POSTED");
  });
});

describe("reading settlements", () => {
  it("lists only this company's receipts and payments", async () => {
    const alpha = await createCompany();
    const beta = await createCompany();

    await createReceipt({
      companyId: alpha.companyId,
      userId: alpha.userId,
      actorEmail: alpha.actorEmail,
      input: receiptInput({ kind: "CAPITAL", partyId: "", amount: 1000 }),
    });
    await createReceipt({
      companyId: beta.companyId,
      userId: beta.userId,
      actorEmail: beta.actorEmail,
      input: receiptInput({ kind: "CAPITAL", partyId: "", amount: 7777 }),
    });
    await createPayment({
      companyId: beta.companyId,
      userId: beta.userId,
      actorEmail: beta.actorEmail,
      input: paymentInput({ kind: "DRAWINGS", partyId: "", amount: 300 }),
    });

    const receipts = await listReceipts({ companyId: alpha.companyId });
    expect(receipts.total).toBe(1);
    expect(receipts.postedTotal).toBe(toStorageString(1000));
    expect(await listPayments({ companyId: alpha.companyId })).toMatchObject({
      total: 0,
    });

    const theirs = await listReceipts({ companyId: beta.companyId });
    expect(theirs.total).toBe(1);
    expect(theirs.rows[0]?.amount).toBe(toStorageString(7777));
  });

  it("excludes a voided receipt from the received total", async () => {
    const fixture = await createCompany();
    const kept = await createReceipt({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: receiptInput({ kind: "CAPITAL", partyId: "", amount: 4000 }),
    });
    const dropped = await createReceipt({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: receiptInput({ kind: "CAPITAL", partyId: "", amount: 6000 }),
    });

    await voidReceipt({
      companyId: fixture.companyId,
      receiptId: dropped.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      reason: "Recorded twice",
    });

    const result = await listReceipts({ companyId: fixture.companyId });
    expect(result.total).toBe(2);
    expect(result.postedTotal).toBe(toStorageString(4000));
    expect(result.rows.find((row) => row.id === kept.id)?.status).toBe(
      "POSTED",
    );
  });

  it("ages receivables and payables from the documents themselves", async () => {
    const fixture = await createCompany();
    await raiseInvoice(fixture);
    await raiseBill(fixture);

    const receivables = await receivablesAgeing(fixture.companyId);
    expect(receivables.summary.total).toBe(toStorageString(1180));
    // 30 days' credit was agreed, so nothing is overdue on the day it is raised.
    expect(receivables.summary.overdue).toBe(toStorageString(0));
    expect(receivables.summary.buckets.current).toBe(toStorageString(1180));
    expect(receivables.parties).toHaveLength(1);
    expect(receivables.parties[0]?.name).toBe("Sharma Provision Store");

    const payables = await payablesAgeing(fixture.companyId);
    expect(payables.summary.total).toBe(toStorageString(1180));
    expect(payables.parties[0]?.name).toBe("Metro Wholesale");

    // Neither ledger sees the other company's documents.
    const other = await createCompany();
    expect((await receivablesAgeing(other.companyId)).summary.total).toBe(
      toStorageString(0),
    );
  });

  it("does not leak another company's outstanding documents", async () => {
    const alpha = await createCompany();
    const beta = await createCompany();
    await raiseInvoice(beta);

    // Beta's customer id against alpha's company: no rows, not an error page.
    expect(
      await openInvoices(prisma, {
        companyId: alpha.companyId,
        customerId: beta.customerId,
      }),
    ).toHaveLength(0);
  });
});

/**
 * Credit and debit notes, which settle a document as surely as money does.
 *
 * "Outstanding is total minus settled" was written when a payment was the only
 * way an invoice got settled. Returns arrived later and nothing revisited what
 * settled meant, so a credit note came off the receivable account and stayed on
 * the ageing report — the subsidiary ledger and its control account disagreeing
 * by the value of every credit note raised. What makes that worse than a wrong
 * number on a screen is where the number goes: the reminder the shop sends its
 * customer, and the cap on how much a receipt may be allocated to the invoice.
 *
 * The pair of cases per side is the point. A return credited to the account
 * reduces what is owed; a return refunded in cash does not, because the money
 * went back over the counter and the invoice still stands. Reading the ledger
 * rather than the return's total is what tells those apart.
 */
describe("what a credit note does to the ageing", () => {
  it("takes the credited amount off what the customer owes", async () => {
    const fixture = await createCompany();
    const invoice = await raiseInvoice(fixture);
    const lines = await returnableLines({
      companyId: fixture.companyId,
      saleId: invoice.id,
    });

    await createSalesReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        saleId: invoice.id,
        returnDate: new Date().toISOString().slice(0, 10),
        reason: "",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: lines[0]!.lineId, quantity: 4 }],
      },
    });

    // The ageing has to agree with the account it summarises. Asserted against
    // the control account rather than a literal, so the two cannot drift apart
    // without this failing.
    const receivable = await accountBalance(
      fixture.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    );
    const ageing = await receivablesAgeing(fixture.companyId);
    expect(Number(ageing.summary.total)).toBeCloseTo(Number(receivable), 2);

    // And the receipt form must not offer to collect more than that: the
    // figure it caps an allocation with is this one.
    const open = await openInvoices(prisma, {
      companyId: fixture.companyId,
      customerId: fixture.customerId,
    });
    expect(Number(open[0]!.outstanding)).toBeCloseTo(Number(receivable), 2);
  }, 90_000);

  /**
   * The figure on the sales page, which is the same question asked again.
   *
   * "On credit" is what customers still owe on invoices, and it was computed
   * from the documents alone — every posted credit sale's total less what had
   * been receipted against it. A credit note settles an invoice exactly as a
   * receipt does, and nothing here subtracted it, so the headline on the page
   * a shopkeeper opens most disagreed with the ageing report, the reminder it
   * sends, and the cap on what a receipt may collect. Four consumers already
   * shared one definition of settled; this was a fifth that had its own.
   */
  it("agrees with what the receipt form will let you collect", async () => {
    const fixture = await createCompany();
    const invoice = await raiseInvoice(fixture);
    const lines = await returnableLines({
      companyId: fixture.companyId,
      saleId: invoice.id,
    });

    await createSalesReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        saleId: invoice.id,
        returnDate: new Date().toISOString().slice(0, 10),
        reason: "",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: lines[0]!.lineId, quantity: 4 }],
      },
    });

    const open = await openInvoices(prisma, {
      companyId: fixture.companyId,
      customerId: fixture.customerId,
    });
    const owed = open.reduce(
      (total, doc) => total + Number(doc.outstanding),
      0,
    );

    const list = await listSales({ companyId: fixture.companyId });
    expect(Number(list.creditOutstanding)).toBeCloseTo(owed, 2);

    // And against the account itself, so the page cannot drift from the books.
    const receivable = await accountBalance(
      fixture.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    );
    expect(Number(list.creditOutstanding)).toBeCloseTo(Number(receivable), 2);
  }, 90_000);

  it("says the same about what is owed to a supplier", async () => {
    const fixture = await createCompany();
    const bill = await raiseBill(fixture);
    const lines = await returnableBillLines({
      companyId: fixture.companyId,
      purchaseId: bill.id,
    });

    await createPurchaseReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        purchaseId: bill.id,
        returnDate: new Date().toISOString().slice(0, 10),
        reason: "",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: lines[0]!.lineId, quantity: 4 }],
      },
    });

    const open = await openBills(prisma, {
      companyId: fixture.companyId,
      supplierId: fixture.supplierId,
    });
    const owed = open.reduce(
      (total, doc) => total + Number(doc.outstanding),
      0,
    );

    const list = await listPurchases({ companyId: fixture.companyId });
    expect(Number(list.payablesOutstanding)).toBeCloseTo(owed, 2);

    const payable = await accountBalance(
      fixture.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE,
    );
    expect(Number(list.payablesOutstanding)).toBeCloseTo(
      Math.abs(Number(payable)),
      2,
    );
  }, 90_000);

  it("leaves the invoice standing when the customer was refunded in cash", async () => {
    // The other half of the rule, and the one a careless fix breaks: cash back
    // over the counter never touched the receivable, so the invoice is still
    // owed in full.
    const fixture = await createCompany();
    const invoice = await raiseInvoice(fixture);
    const lines = await returnableLines({
      companyId: fixture.companyId,
      saleId: invoice.id,
    });

    const before = await receivablesAgeing(fixture.companyId);

    await createSalesReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        saleId: invoice.id,
        returnDate: new Date().toISOString().slice(0, 10),
        reason: "",
        refundMode: "CASH",
        lines: [{ sourceLineId: lines[0]!.lineId, quantity: 4 }],
      },
    });

    const after = await receivablesAgeing(fixture.companyId);
    expect(Number(after.summary.total)).toBeCloseTo(
      Number(before.summary.total),
      2,
    );

    const receivable = await accountBalance(
      fixture.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    );
    expect(Number(after.summary.total)).toBeCloseTo(Number(receivable), 2);
  }, 90_000);

  it("takes a debit note off what the business owes its supplier", async () => {
    const fixture = await createCompany();
    const bill = await raiseBill(fixture);
    const lines = await returnableBillLines({
      companyId: fixture.companyId,
      purchaseId: bill.id,
    });

    await createPurchaseReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        purchaseId: bill.id,
        returnDate: new Date().toISOString().slice(0, 10),
        reason: "",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: lines[0]!.lineId, quantity: 4 }],
      },
    });

    // Payables are a credit balance, so the control account is negative here.
    const payable = await accountBalance(
      fixture.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE,
    );
    const ageing = await payablesAgeing(fixture.companyId);
    expect(Number(ageing.summary.total)).toBeCloseTo(-Number(payable), 2);

    const open = await openBills(prisma, {
      companyId: fixture.companyId,
      supplierId: fixture.supplierId,
    });
    expect(Number(open[0]!.outstanding)).toBeCloseTo(-Number(payable), 2);
  }, 90_000);

  it("still reports an invoice nothing has come back against", async () => {
    // The ordinary path, which the netting must not quietly reduce.
    const fixture = await createCompany();
    const invoice = await raiseInvoice(fixture);

    const receivable = await accountBalance(
      fixture.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    );
    const ageing = await receivablesAgeing(fixture.companyId);
    expect(Number(ageing.summary.total)).toBeCloseTo(Number(receivable), 2);
    expect(Number(ageing.summary.total)).toBeGreaterThan(0);

    const open = await openInvoices(prisma, {
      companyId: fixture.companyId,
      customerId: fixture.customerId,
    });
    expect(open).toHaveLength(1);
    expect(Number(open[0]!.outstanding)).toBeCloseTo(
      Number(invoice.totalAmount),
      2,
    );
  }, 90_000);
});

/**
 * The allocation cap, once a credit note exists.
 *
 * "Allocation never exceeds what is owed" is one of the two ideas this module
 * is built on, and it read *owed* as total minus payments. A credit note
 * settles a document as surely as money does, so an invoice of 1,180 carrying
 * a 472 credit note would accept a receipt for the whole 1,180 — 472 more than
 * the customer owed — and put their account quietly into credit.
 *
 * Netting the notes into the ageing report fixed what the screen offered and
 * left what the server would accept where it was, so the two came apart. That
 * is the worse half of the pair: the cap is what catches a keying error at the
 * till, and a cap the form applies but the server does not is not a cap.
 */
describe("what a credit note does to the allocation cap", () => {
  async function invoiceWithCreditNote() {
    const fixture = await createCompany();
    const invoice = await raiseInvoice(fixture);
    const lines = await returnableLines({
      companyId: fixture.companyId,
      saleId: invoice.id,
    });

    await createSalesReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        saleId: invoice.id,
        returnDate: new Date().toISOString().slice(0, 10),
        reason: "",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: lines[0]!.lineId, quantity: 4 }],
      },
    });

    // Taken from the reader rather than computed here, so the guard and the
    // screen are asserted to agree rather than assumed to.
    const open = await openInvoices(prisma, {
      companyId: fixture.companyId,
      customerId: fixture.customerId,
    });
    return { fixture, invoice, owed: Number(open[0]!.outstanding) };
  }

  it("refuses a receipt for more than the invoice still owes", async () => {
    const { fixture, invoice, owed } = await invoiceWithCreditNote();
    const full = Number(invoice.totalAmount);
    expect(full).toBeGreaterThan(owed);

    await expect(
      createReceipt({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        input: receiptInput({
          partyId: fixture.customerId,
          amount: full,
          allocations: [{ documentId: invoice.id, amount: full }],
        }),
      }),
    ).rejects.toMatchObject({ code: "OVER_ALLOCATED" });

    // Refused before anything was written: the invoice is untouched.
    const untouched = await prisma.sale.findUniqueOrThrow({
      where: { id: invoice.id },
      select: { paidAmount: true },
    });
    expect(Number(untouched.paidAmount)).toBe(0);
  }, 90_000);

  it("names the amount actually left, not the invoice total", async () => {
    // The message is the whole use of the cap at a till: it has to say what
    // may be taken, or the person is left guessing at the counter.
    const { fixture, invoice, owed } = await invoiceWithCreditNote();
    const full = Number(invoice.totalAmount);

    await expect(
      createReceipt({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        input: receiptInput({
          partyId: fixture.customerId,
          amount: full,
          allocations: [{ documentId: invoice.id, amount: full }],
        }),
      }),
    ).rejects.toThrow(new RegExp(owed.toFixed(2).replace(".", "\\.")));
  }, 90_000);

  it("still takes exactly what is left after the credit note", async () => {
    // The ordinary path, which a tighter cap must not catch up in it.
    const { fixture, invoice, owed } = await invoiceWithCreditNote();

    const receipt = await createReceipt({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: receiptInput({
        partyId: fixture.customerId,
        amount: owed,
        allocations: [{ documentId: invoice.id, amount: owed }],
      }),
    });
    expect(Number(receipt.unallocated)).toBe(0);

    // Settled in full: the receivable stands at nil, so the cap let through
    // exactly what the invoice owed and no less.
    const receivable = await accountBalance(
      fixture.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    );
    expect(Number(receivable)).toBeCloseTo(0, 2);
    await assertTrialBalances(fixture.companyId);
  }, 90_000);

  it("refuses a payment for more than a bill owes after a debit note", async () => {
    const fixture = await createCompany();
    const bill = await raiseBill(fixture);
    const lines = await returnableBillLines({
      companyId: fixture.companyId,
      purchaseId: bill.id,
    });

    await createPurchaseReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        purchaseId: bill.id,
        returnDate: new Date().toISOString().slice(0, 10),
        reason: "",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: lines[0]!.lineId, quantity: 4 }],
      },
    });

    const full = Number(bill.totalAmount);
    await expect(
      createPayment({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        input: paymentInput({
          partyId: fixture.supplierId,
          amount: full,
          allocations: [{ documentId: bill.id, amount: full }],
        }),
      }),
    ).rejects.toMatchObject({ code: "OVER_ALLOCATED" });
  }, 90_000);
});

/**
 * Archiving somebody who still owes money.
 *
 * Archiving a customer does not settle their debt. The ageing report goes on
 * listing it, because it is real — and the ledger's party picker dropped them,
 * so the one document a shop sends somebody disputing a balance could not be
 * produced for them at all. The books said chase this person and the
 * application would not say what for.
 *
 * `ledgerAccounts` keeps a retired account that still carries history, and says
 * why in its own comment. The parties beneath it were not doing the same thing.
 */
describe("a party archived while still carrying a balance", () => {
  async function archivedDebtor() {
    const fixture = await createCompany();
    const invoice = await raiseInvoice(fixture);
    const { setPartyArchived } =
      await import("@/server/master-data/party-service");
    await setPartyArchived({
      companyId: fixture.companyId,
      kind: "CUSTOMER",
      partyId: fixture.customerId,
      archived: true,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
    });
    return { fixture, invoice };
  }

  it("is still listed on the ledger, because the ageing still chases them", async () => {
    const { fixture } = await archivedDebtor();

    const ageing = await receivablesAgeing(fixture.companyId);
    expect(Number(ageing.summary.total)).toBeGreaterThan(0);

    const parties = await ledgerParties({
      companyId: fixture.companyId,
      partyType: "CUSTOMER",
    });
    const listed = parties.find((party) => party.id === fixture.customerId);
    expect(listed).toBeDefined();

    // And the statement the shop would send them reconciles with that figure,
    // which is the whole reason the name has to be reachable.
    const statement = await partyStatement({
      companyId: fixture.companyId,
      partyType: "CUSTOMER",
      partyId: fixture.customerId,
    });
    expect(Number(statement.closingBalance)).toBeCloseTo(
      Number(ageing.summary.total),
      2,
    );
  }, 90_000);

  it("is marked archived, so the name is not a surprise", async () => {
    const { fixture } = await archivedDebtor();

    const parties = await ledgerParties({
      companyId: fixture.companyId,
      partyType: "CUSTOMER",
    });
    expect(
      parties.find((party) => party.id === fixture.customerId)!.archived,
    ).toBe(true);
  }, 90_000);

  it("drops an archived party who never traded", async () => {
    // Archiving still does what archiving is for. It is the history keeping
    // the name on the list, not the party.
    const fixture = await createCompany();
    const { setPartyArchived } =
      await import("@/server/master-data/party-service");
    await setPartyArchived({
      companyId: fixture.companyId,
      kind: "CUSTOMER",
      partyId: fixture.customerId,
      archived: true,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
    });

    const parties = await ledgerParties({
      companyId: fixture.companyId,
      partyType: "CUSTOMER",
    });
    expect(
      parties.find((party) => party.id === fixture.customerId),
    ).toBeUndefined();
  }, 90_000);

  it("leaves a trading customer listed and unmarked", async () => {
    const fixture = await createCompany();
    await raiseInvoice(fixture);

    const parties = await ledgerParties({
      companyId: fixture.companyId,
      partyType: "CUSTOMER",
    });
    const listed = parties.find((party) => party.id === fixture.customerId);
    expect(listed).toBeDefined();
    expect(listed!.archived).toBe(false);
  }, 90_000);
});

/**
 * What the ageing report owes the control account behind it.
 *
 * The README says a customer statement "reconciles with the ageing report
 * exactly, because both are derived from the same posted lines". They were not
 * the same lines. The statement reads the receivable control account; the ageing
 * read sale rows. Everything that reaches a receivable without being a sale was
 * therefore invisible to it.
 *
 * The case that matters is the first thing a real shop does: carry its customers
 * over from the old books with what they already owe. Fifty thousand rupees of
 * opening balances went into the receivable account and the receivables report —
 * on the dashboard, in the reports catalogue, and in what the advisor reasons
 * from — read nil.
 *
 * Each case below asserts against the control account rather than a literal, so
 * the two cannot come apart again without one of them failing.
 */
describe("the ageing against the control account", () => {
  async function carriedOver(amount: number, nature: "DEBIT" | "CREDIT") {
    const fixture = await createCompany();
    const { createParty: mkParty } =
      await import("@/server/master-data/party-service");
    const party = await mkParty({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      kind: "CUSTOMER",
      input: {
        name: "Carried Over Traders",
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
        openingBalance: amount,
        openingNature: nature,
        notes: "",
      } as never,
    });
    return { fixture, partyId: party.id };
  }

  it("counts a customer carried over from the old books", async () => {
    const { fixture, partyId } = await carriedOver(50_000, "DEBIT");

    const receivable = await accountBalance(
      fixture.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    );
    const ageing = await receivablesAgeing(fixture.companyId);

    expect(Number(receivable)).toBeCloseTo(50_000, 2);
    expect(Number(ageing.summary.total)).toBeCloseTo(Number(receivable), 2);

    // And named, so the shop knows who to chase rather than seeing a lump.
    const party = ageing.parties.find((entry) => entry.id === partyId);
    expect(party).toBeDefined();
    expect(Number(party!.outstanding)).toBeCloseTo(50_000, 2);
  }, 90_000);

  it("still ties once that customer starts trading", async () => {
    // The carried balance and ordinary invoices have to add up together, not
    // one replace the other.
    const { fixture } = await carriedOver(50_000, "DEBIT");
    await raiseInvoice(fixture);

    const receivable = await accountBalance(
      fixture.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    );
    const ageing = await receivablesAgeing(fixture.companyId);
    expect(Number(ageing.summary.total)).toBeCloseTo(Number(receivable), 2);
    expect(Number(ageing.summary.total)).toBeGreaterThan(50_000);
  }, 90_000);

  it("nets money taken without being matched to an invoice", async () => {
    // An advance genuinely reduces what a customer owes. Read from documents
    // alone it did not, so the report overstated the debt by the payment.
    const fixture = await createCompany();
    await raiseInvoice(fixture);
    await createReceipt({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: receiptInput({ partyId: fixture.customerId, amount: 400 }),
    });

    const receivable = await accountBalance(
      fixture.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    );
    const ageing = await receivablesAgeing(fixture.companyId);
    expect(Number(ageing.summary.total)).toBeCloseTo(Number(receivable), 2);
  }, 90_000);

  it("ties on the payables side too", async () => {
    const fixture = await createCompany();
    await raiseBill(fixture);

    const payable = await accountBalance(
      fixture.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE,
    );
    const ageing = await payablesAgeing(fixture.companyId);
    // Payables sit as a credit balance, so the control account reads negative.
    expect(Number(ageing.summary.total)).toBeCloseTo(-Number(payable), 2);
  }, 90_000);

  it("leaves an ordinary invoice reading exactly as it did", async () => {
    // The residual must be nil when documents already explain the balance,
    // or every existing figure would shift.
    const fixture = await createCompany();
    const invoice = await raiseInvoice(fixture);

    const receivable = await accountBalance(
      fixture.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    );
    const ageing = await receivablesAgeing(fixture.companyId);
    expect(Number(ageing.summary.total)).toBeCloseTo(
      Number(invoice.totalAmount),
      2,
    );
    expect(Number(ageing.summary.total)).toBeCloseTo(Number(receivable), 2);
    expect(ageing.parties).toHaveLength(1);
  }, 90_000);
});
