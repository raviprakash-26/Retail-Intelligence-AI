import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { trialBalanceIsBalanced } from "@/lib/accounting/double-entry";
import { add, subtract, toStorageString } from "@/lib/money";
import type { RegisterInput } from "@/lib/validation/auth";
import type { ProductInput, SupplierInput } from "@/lib/validation/master-data";
import type { PurchaseInput } from "@/lib/validation/purchases";
import type { SaleInput } from "@/lib/validation/sales";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import {
  createPurchase,
  voidPurchase,
  PurchaseError,
} from "@/server/purchases/purchase-service";
import { createSale } from "@/server/sales/sale-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

type Registration = "REGULAR" | "COMPOSITION" | "UNREGISTERED";

function registrationInput(email: string, scheme: Registration): RegisterInput {
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
      businessName: "Purchase Test Mart",
      businessType: "SOLE_PROPRIETORSHIP",
      gstRegistration: scheme,
      gstin: scheme === "UNREGISTERED" ? "" : "29AAAPR1234K1ZP",
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
  unitId: string;
  taxRate18Id: string;
};

async function createCompany(
  scheme: Registration = "REGULAR",
): Promise<Fixture> {
  const email = `purch-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email, scheme));
  createdCompanies.push(result.companyId);

  const taxonomy = await getProductTaxonomy(result.companyId);
  const unit = taxonomy.units.find((entry) => entry.code === "PCS");
  const gst18 = taxonomy.taxRates.find((entry) => entry.code === "GST18");
  if (!unit || !gst18) throw new Error("Provisioning is incomplete");

  return {
    companyId: result.companyId,
    userId: result.userId,
    actorEmail: "owner@example.com",
    unitId: unit.id,
    taxRate18Id: gst18.id,
  };
}

function productInput(
  fixture: Fixture,
  overrides: Partial<ProductInput> = {},
): ProductInput {
  return {
    sku: "WIDGET",
    name: "Widget",
    description: "",
    barcode: "",
    hsnCode: "1905",
    categoryId: "",
    unitId: fixture.unitId,
    taxRateId: fixture.taxRate18Id,
    purchasePrice: 100,
    sellingPrice: 150,
    mrp: 0,
    isStockTracked: true,
    openingQuantity: 0,
    openingRate: 0,
    minStockLevel: 0,
    ...overrides,
  };
}

function supplierInput(overrides: Partial<SupplierInput> = {}): SupplierInput {
  return {
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
    ...overrides,
  };
}

function billInput(
  supplierId: string,
  productId: string,
  overrides: Partial<PurchaseInput> = {},
): PurchaseInput {
  return {
    supplierId,
    supplierBillNo: "",
    billDate: new Date().toISOString().slice(0, 10),
    paymentMode: "CREDIT",
    priceIncludesTax: false,
    claimInputCredit: true,
    notes: "",
    lines: [
      {
        productId,
        description: "",
        quantity: 10,
        rate: 100,
        discountPercent: 0,
      },
    ],
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

async function fixtureWithParties(scheme: Registration = "REGULAR") {
  const fixture = await createCompany(scheme);
  const [supplier, product] = await Promise.all([
    createParty({
      companyId: fixture.companyId,
      kind: "SUPPLIER",
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: supplierInput(),
    }),
    createProduct({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: productInput(fixture),
    }),
  ]);
  return { ...fixture, supplierId: supplier.id, productId: product.id };
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

describe("posting a credit bill", () => {
  it("brings stock in at cost and holds the tax as recoverable", async () => {
    const fixture = await fixtureWithParties();

    const bill = await createPurchase({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: billInput(fixture.supplierId, fixture.productId),
    });

    // ₹1,000 of goods at 18% = ₹1,180 owed to the supplier.
    expect(bill.totalAmount).toBe(toStorageString(1180));
    expect(bill.supplyType).toBe("INTRA_STATE");
    expect(bill.itcEligible).toBe(true);

    // Stock carries the goods only. The tax comes back, so it is not a cost.
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.INVENTORY),
    ).toBe(toStorageString(1000));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.GST_INPUT_CGST),
    ).toBe(toStorageString(90));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.GST_INPUT_SGST),
    ).toBe(toStorageString(90));
    // Payables is a credit balance, so its net debit is negative.
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE),
    ).toBe(toStorageString(-1180));

    await assertTrialBalances(fixture.companyId);
  });

  it("records the stock position and its unit cost", async () => {
    const fixture = await fixtureWithParties();
    await createPurchase({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: billInput(fixture.supplierId, fixture.productId),
    });

    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { companyId: fixture.companyId, productId: fixture.productId },
      select: { quantity: true, averageCost: true, stockValue: true },
    });
    expect(toStorageString(balance.quantity)).toBe(toStorageString(10));
    expect(toStorageString(balance.averageCost)).toBe(toStorageString(100));
    expect(toStorageString(balance.stockValue)).toBe(toStorageString(1000));

    const movement = await prisma.inventoryMovement.findFirstOrThrow({
      where: { companyId: fixture.companyId, productId: fixture.productId },
      select: { movementType: true, quantity: true, unitCost: true },
    });
    expect(movement.movementType).toBe("PURCHASE");
    expect(toStorageString(movement.quantity)).toBe(toStorageString(10));
  });

  it("writes the inward supply to the GST register as claimable", async () => {
    const fixture = await fixtureWithParties();
    const bill = await createPurchase({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: billInput(fixture.supplierId, fixture.productId),
    });

    const rows = await prisma.gstTransaction.findMany({
      where: { companyId: fixture.companyId, documentId: bill.id },
      select: {
        direction: true,
        itcEligible: true,
        taxableValue: true,
        totalTax: true,
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.direction).toBe("INWARD");
    expect(rows[0]?.itcEligible).toBe(true);
    expect(toStorageString(rows[0]?.totalTax ?? 0)).toBe(toStorageString(180));
  });

  it("pays cash immediately when the bill is not on credit", async () => {
    const fixture = await fixtureWithParties();
    await createPurchase({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: billInput(fixture.supplierId, fixture.productId, {
        paymentMode: "CASH",
      }),
    });

    expect(await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.CASH)).toBe(
      toStorageString(-1180),
    );
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE),
    ).toBe(toStorageString(0));
  });
});

describe("input tax credit", () => {
  it("lands the tax onto the stock when credit is not claimed", async () => {
    const fixture = await fixtureWithParties();

    const bill = await createPurchase({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: billInput(fixture.supplierId, fixture.productId, {
        claimInputCredit: false,
      }),
    });

    expect(bill.itcEligible).toBe(false);
    // The whole ₹1,180 is what the goods cost, because the tax is not coming
    // back. Holding it in an input account that can never be claimed would
    // overstate assets for as long as the business exists.
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.INVENTORY),
    ).toBe(toStorageString(1180));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.GST_INPUT_CGST),
    ).toBe(toStorageString(0));

    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { companyId: fixture.companyId, productId: fixture.productId },
      select: { averageCost: true },
    });
    expect(toStorageString(balance.averageCost)).toBe(toStorageString(118));

    await assertTrialBalances(fixture.companyId);
  });

  it("refuses credit to a composition dealer whatever the form asks for", async () => {
    const fixture = await fixtureWithParties("COMPOSITION");

    const bill = await createPurchase({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: billInput(fixture.supplierId, fixture.productId, {
        claimInputCredit: true,
      }),
    });

    // A composition dealer cannot set input tax off against output tax, so the
    // request is overruled rather than honoured.
    expect(bill.itcEligible).toBe(false);
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.INVENTORY),
    ).toBe(toStorageString(1180));
  });

  it("refuses credit to an unregistered business", async () => {
    const fixture = await fixtureWithParties("UNREGISTERED");
    const bill = await createPurchase({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: billInput(fixture.supplierId, fixture.productId),
    });
    expect(bill.itcEligible).toBe(false);
  });
});

describe("who is selling", () => {
  it("charges no GST when the supplier is not registered", async () => {
    const fixture = await createCompany();
    const [supplier, product] = await Promise.all([
      createParty({
        companyId: fixture.companyId,
        kind: "SUPPLIER",
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        input: supplierInput({
          name: "Local Vendor",
          gstin: "",
          stateCode: "29",
        }),
      }),
      createProduct({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        input: productInput(fixture),
      }),
    ]);

    const bill = await createPurchase({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: billInput(supplier.id, product.id),
    });

    // On a purchase the supplier is the seller, so their registration decides
    // whether the bill carries tax at all.
    expect(bill.supplyType).toBe("NON_GST");
    expect(bill.totalAmount).toBe(toStorageString(1000));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.GST_INPUT_CGST),
    ).toBe(toStorageString(0));
  });

  it("charges IGST when the supplier is in another state", async () => {
    const fixture = await createCompany();
    const [supplier, product] = await Promise.all([
      createParty({
        companyId: fixture.companyId,
        kind: "SUPPLIER",
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        input: supplierInput({
          name: "Mumbai Wholesale",
          gstin: "27AABCA1234C1Z5",
          stateCode: "27",
        }),
      }),
      createProduct({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        input: productInput(fixture),
      }),
    ]);

    const bill = await createPurchase({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: billInput(supplier.id, product.id),
    });

    expect(bill.supplyType).toBe("INTER_STATE");
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.GST_INPUT_IGST),
    ).toBe(toStorageString(180));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.GST_INPUT_CGST),
    ).toBe(toStorageString(0));
  });
});

describe("duplicate bills", () => {
  it("refuses a supplier's bill number that is already recorded", async () => {
    const fixture = await fixtureWithParties();
    await createPurchase({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: billInput(fixture.supplierId, fixture.productId, {
        supplierBillNo: "2451",
      }),
    });

    // Paying the same bill twice is easy to do and hard to notice afterwards.
    await expect(
      createPurchase({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        branchId: null,
        input: billInput(fixture.supplierId, fixture.productId, {
          supplierBillNo: "2451",
        }),
      }),
    ).rejects.toThrow(/already recorded as BILL-0001/);
  });

  it("allows the same reference from a different supplier", async () => {
    const fixture = await fixtureWithParties();
    const other = await createParty({
      companyId: fixture.companyId,
      kind: "SUPPLIER",
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: supplierInput({ name: "Other Traders" }),
    });

    await createPurchase({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: billInput(fixture.supplierId, fixture.productId, {
        supplierBillNo: "1",
      }),
    });

    // Two suppliers numbering their own bills from 1 is normal.
    await expect(
      createPurchase({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        branchId: null,
        input: billInput(other.id, fixture.productId, { supplierBillNo: "1" }),
      }),
    ).resolves.toBeDefined();
  });

  it("frees the reference again once a bill is voided", async () => {
    const fixture = await fixtureWithParties();
    const bill = await createPurchase({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: billInput(fixture.supplierId, fixture.productId, {
        supplierBillNo: "2451",
      }),
    });

    await voidPurchase({
      companyId: fixture.companyId,
      purchaseId: bill.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      reason: "Entered against the wrong supplier",
    });

    // Re-entering a bill that was voided is the whole point of voiding it.
    await expect(
      createPurchase({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        branchId: null,
        input: billInput(fixture.supplierId, fixture.productId, {
          supplierBillNo: "2451",
        }),
      }),
    ).resolves.toBeDefined();
  });
});

describe("voiding", () => {
  it("reverses the entry, the stock and the register", async () => {
    const fixture = await fixtureWithParties();
    const bill = await createPurchase({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: billInput(fixture.supplierId, fixture.productId),
    });

    await voidPurchase({
      companyId: fixture.companyId,
      purchaseId: bill.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      reason: "Goods never arrived",
    });

    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.INVENTORY),
    ).toBe(toStorageString(0));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.GST_INPUT_CGST),
    ).toBe(toStorageString(0));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE),
    ).toBe(toStorageString(0));

    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { companyId: fixture.companyId, productId: fixture.productId },
      select: { quantity: true },
    });
    expect(toStorageString(balance.quantity)).toBe(toStorageString(0));

    const gstNet = await prisma.gstTransaction.aggregate({
      where: { companyId: fixture.companyId, documentId: bill.id },
      _sum: { totalTax: true },
    });
    expect(toStorageString(gstNet._sum.totalTax ?? 0)).toBe(toStorageString(0));

    await assertTrialBalances(fixture.companyId);
  });

  it("refuses when the stock has already been sold, and says so", async () => {
    const fixture = await fixtureWithParties();
    const bill = await createPurchase({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: billInput(fixture.supplierId, fixture.productId),
    });

    const sale: SaleInput = {
      customerId: "",
      invoiceDate: new Date().toISOString().slice(0, 10),
      paymentMode: "CASH",
      placeOfSupply: "",
      priceIncludesTax: false,
      notes: "",
      lines: [
        {
          productId: fixture.productId,
          description: "",
          quantity: 6,
          rate: 150,
          discountPercent: 0,
        },
      ],
    };
    await createSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: sale,
    });

    // Taking the stock back out would drive the position negative and
    // fabricate a cost, so the void is refused with the figures.
    await expect(
      voidPurchase({
        companyId: fixture.companyId,
        purchaseId: bill.id,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        reason: "Wrong supplier",
      }),
    ).rejects.toThrow(/only 4 PCS are left of the 10/);

    // And the bill is untouched, not half-voided.
    const untouched = await prisma.purchase.findUniqueOrThrow({
      where: { id: bill.id },
      select: { status: true },
    });
    expect(untouched.status).toBe("POSTED");
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE),
    ).toBe(toStorageString(-1180));
  });

  it("refuses to void the same bill twice", async () => {
    const fixture = await fixtureWithParties();
    const bill = await createPurchase({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: billInput(fixture.supplierId, fixture.productId),
    });

    const voidIt = () =>
      voidPurchase({
        companyId: fixture.companyId,
        purchaseId: bill.id,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        reason: "Duplicate entry",
      });

    await voidIt();
    await expect(voidIt()).rejects.toThrow(/already been voided/);
  });
});

describe("buying then selling", () => {
  it("blends the cost of two receipts and charges the blend to cost of sales", async () => {
    const fixture = await fixtureWithParties();

    await createPurchase({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: billInput(fixture.supplierId, fixture.productId, {
        supplierBillNo: "A1",
        lines: [
          {
            productId: fixture.productId,
            description: "",
            quantity: 10,
            rate: 100,
            discountPercent: 0,
          },
        ],
      }),
    });

    await createPurchase({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: billInput(fixture.supplierId, fixture.productId, {
        supplierBillNo: "A2",
        lines: [
          {
            productId: fixture.productId,
            description: "",
            quantity: 10,
            rate: 140,
            discountPercent: 0,
          },
        ],
      }),
    });

    // 10 at ₹100 and 10 at ₹140 is 20 at ₹120.
    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { companyId: fixture.companyId, productId: fixture.productId },
      select: { averageCost: true, quantity: true },
    });
    expect(toStorageString(balance.averageCost)).toBe(toStorageString(120));
    expect(toStorageString(balance.quantity)).toBe(toStorageString(20));

    await createSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        customerId: "",
        invoiceDate: new Date().toISOString().slice(0, 10),
        paymentMode: "CASH",
        placeOfSupply: "",
        priceIncludesTax: false,
        notes: "",
        lines: [
          {
            productId: fixture.productId,
            description: "",
            quantity: 5,
            rate: 200,
            discountPercent: 0,
          },
        ],
      },
    });

    // Five units at the blended ₹120.
    expect(
      await accountBalance(
        fixture.companyId,
        SYSTEM_ACCOUNT.COST_OF_GOODS_SOLD,
      ),
    ).toBe(toStorageString(600));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.INVENTORY),
    ).toBe(toStorageString(1800));

    await assertTrialBalances(fixture.companyId);
  });

  it("nets input credit against output tax across a buy and a sell", async () => {
    const fixture = await fixtureWithParties();

    await createPurchase({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: billInput(fixture.supplierId, fixture.productId),
    });

    await createSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        customerId: "",
        invoiceDate: new Date().toISOString().slice(0, 10),
        paymentMode: "CASH",
        placeOfSupply: "",
        priceIncludesTax: false,
        notes: "",
        lines: [
          {
            productId: fixture.productId,
            description: "",
            quantity: 10,
            rate: 150,
            discountPercent: 0,
          },
        ],
      },
    });

    // Bought ₹1,000 + ₹180 tax, sold ₹1,500 + ₹270 tax. The ₹90 of net CGST
    // owed is the difference between the two, which is what a return reports.
    const inputCgst = await accountBalance(
      fixture.companyId,
      SYSTEM_ACCOUNT.GST_INPUT_CGST,
    );
    const outputCgst = await accountBalance(
      fixture.companyId,
      SYSTEM_ACCOUNT.GST_OUTPUT_CGST,
    );
    expect(inputCgst).toBe(toStorageString(90));
    expect(outputCgst).toBe(toStorageString(-135));
    // Both are net debits, so adding them gives the position: −45 means ₹45 of
    // CGST is owed, which is exactly what a return would report.
    expect(toStorageString(add(inputCgst, outputCgst))).toBe(
      toStorageString(-45),
    );

    await assertTrialBalances(fixture.companyId);
  });
});

describe("tenant isolation", () => {
  it("cannot bill against another company's supplier", async () => {
    const [mine, theirs] = await Promise.all([
      fixtureWithParties(),
      fixtureWithParties(),
    ]);

    await expect(
      createPurchase({
        companyId: mine.companyId,
        userId: mine.userId,
        actorEmail: mine.actorEmail,
        branchId: null,
        input: billInput(theirs.supplierId, mine.productId),
      }),
    ).rejects.toThrow(/could not be found/);
  });

  it("cannot void another company's bill", async () => {
    const [mine, theirs] = await Promise.all([
      fixtureWithParties(),
      fixtureWithParties(),
    ]);
    const theirBill = await createPurchase({
      companyId: theirs.companyId,
      userId: theirs.userId,
      actorEmail: theirs.actorEmail,
      branchId: null,
      input: billInput(theirs.supplierId, theirs.productId),
    });

    await expect(
      voidPurchase({
        companyId: mine.companyId,
        purchaseId: theirBill.id,
        userId: mine.userId,
        actorEmail: mine.actorEmail,
        reason: "Not mine to void",
      }),
    ).rejects.toThrow(PurchaseError);

    const untouched = await prisma.purchase.findUniqueOrThrow({
      where: { id: theirBill.id },
      select: { status: true },
    });
    expect(untouched.status).toBe("POSTED");
  });
});
