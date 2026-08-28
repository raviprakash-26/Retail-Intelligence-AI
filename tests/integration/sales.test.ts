import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { trialBalanceIsBalanced } from "@/lib/accounting/double-entry";
import { subtract, toStorageString } from "@/lib/money";
import { seriesPrefix } from "@/lib/documents/sequences";
import type { RegisterInput } from "@/lib/validation/auth";
import type { CustomerInput, ProductInput } from "@/lib/validation/master-data";
import type { SaleInput } from "@/lib/validation/sales";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale, voidSale, SaleError } from "@/server/sales/sale-service";
import { createReceipt } from "@/server/settlements/settlement-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

const prisma = testDb();

/**
 * The invoice series for the company's current fiscal year, e.g. `INV-2627-`.
 *
 * Read from the year rather than written out, because the series carries the
 * year it belongs to — that is what keeps a number that restarts every April
 * unique to one document.
 */
async function invoicePrefix(companyId: string): Promise<string> {
  const year = await prisma.fiscalYear.findFirstOrThrow({
    where: { companyId, isCurrent: true },
    select: { label: true },
  });
  return seriesPrefix("INV-", year.label);
}
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

function registrationInput(email: string, stateCode = "29"): RegisterInput {
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
      businessName: "Sales Test Mart",
      businessType: "SOLE_PROPRIETORSHIP",
      gstRegistration: "REGULAR",
      gstin: stateCode === "29" ? "29AAAPR1234K1ZP" : "27AAAPR1234K1ZY",
      pan: "AAAPR1234K",
      addressLine1: "42 Avenue Road",
      city: "Bengaluru",
      stateCode,
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
  taxRate0Id: string;
};

async function createCompany(stateCode = "29"): Promise<Fixture> {
  const email = `sales-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email, stateCode));
  createdCompanies.push(result.companyId);

  const taxonomy = await getProductTaxonomy(result.companyId);
  const unit = taxonomy.units.find((entry) => entry.code === "PCS");
  const gst18 = taxonomy.taxRates.find((entry) => entry.code === "GST18");
  const gst0 = taxonomy.taxRates.find((entry) => entry.code === "GST0");
  if (!unit || !gst18 || !gst0) throw new Error("Provisioning is incomplete");

  return {
    companyId: result.companyId,
    userId: result.userId,
    actorEmail: "owner@example.com",
    unitId: unit.id,
    taxRate18Id: gst18.id,
    taxRate0Id: gst0.id,
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
    purchasePrice: 60,
    sellingPrice: 100,
    mrp: 0,
    isStockTracked: true,
    openingQuantity: 100,
    openingRate: 60,
    minStockLevel: 0,
    ...overrides,
  };
}

function customerInput(overrides: Partial<CustomerInput> = {}): CustomerInput {
  return {
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
    creditLimit: 100000,
    openingBalance: 0,
    openingNature: "DEBIT",
    notes: "",
    ...overrides,
  };
}

function saleInput(
  productId: string,
  overrides: Partial<SaleInput> = {},
): SaleInput {
  return {
    customerId: "",
    invoiceDate: new Date().toISOString().slice(0, 10),
    paymentMode: "CASH",
    placeOfSupply: "",
    priceIncludesTax: false,
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

/** Net debit posted to a system account across every posted journal line. */
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

describe("posting a cash sale", () => {
  it("records revenue, tax and cost in one balanced entry", async () => {
    const fixture = await createCompany();
    const product = await createProduct({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: productInput(fixture),
    });

    const sale = await createSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: saleInput(product.id),
    });

    // ₹1,000 of goods at 18% = ₹1,180 collected in cash.
    expect(sale.totalAmount).toBe(toStorageString(1180));
    expect(sale.supplyType).toBe("INTRA_STATE");

    expect(await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.CASH)).toBe(
      toStorageString(1180),
    );
    // Revenue is a credit, so its net debit is negative.
    expect(await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.SALES)).toBe(
      toStorageString(-1000),
    );
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.GST_OUTPUT_CGST),
    ).toBe(toStorageString(-90));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.GST_OUTPUT_SGST),
    ).toBe(toStorageString(-90));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.GST_OUTPUT_IGST),
    ).toBe(toStorageString(0));

    // Ten units left at ₹60 each.
    expect(
      await accountBalance(
        fixture.companyId,
        SYSTEM_ACCOUNT.COST_OF_GOODS_SOLD,
      ),
    ).toBe(toStorageString(600));

    await assertTrialBalances(fixture.companyId);
  });

  it("takes the stock it sold out of inventory", async () => {
    const fixture = await createCompany();
    const product = await createProduct({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: productInput(fixture),
    });

    await createSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: saleInput(product.id),
    });

    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { companyId: fixture.companyId, productId: product.id },
      select: { quantity: true, stockValue: true, averageCost: true },
    });

    expect(toStorageString(balance.quantity)).toBe(toStorageString(90));
    expect(toStorageString(balance.stockValue)).toBe(toStorageString(5400));
    // Selling does not change what the remaining units cost.
    expect(toStorageString(balance.averageCost)).toBe(toStorageString(60));

    // Inventory on the balance sheet agrees with the stock ledger.
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.INVENTORY),
    ).toBe(toStorageString(5400));

    const movements = await prisma.inventoryMovement.findMany({
      where: { companyId: fixture.companyId, productId: product.id },
      select: { movementType: true, quantity: true, balanceQuantity: true },
      orderBy: { createdAt: "asc" },
    });
    expect(movements.map((movement) => movement.movementType)).toEqual([
      "OPENING",
      "SALE",
    ]);
    expect(toStorageString(movements[1]?.quantity ?? 0)).toBe(
      toStorageString(-10),
    );
  });

  it("writes the outward supply to the GST register", async () => {
    const fixture = await createCompany();
    const product = await createProduct({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: productInput(fixture),
    });

    const sale = await createSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: saleInput(product.id),
    });

    const rows = await prisma.gstTransaction.findMany({
      where: { companyId: fixture.companyId, documentId: sale.id },
      select: {
        direction: true,
        hsnCode: true,
        taxableValue: true,
        cgstAmount: true,
        sgstAmount: true,
        totalTax: true,
        supplyType: true,
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.direction).toBe("OUTWARD");
    expect(rows[0]?.hsnCode).toBe("1905");
    expect(toStorageString(rows[0]?.taxableValue ?? 0)).toBe(
      toStorageString(1000),
    );
    expect(toStorageString(rows[0]?.totalTax ?? 0)).toBe(toStorageString(180));
  });
});

describe("payment modes", () => {
  it("puts a UPI sale into the bank, not the cash tin", async () => {
    const fixture = await createCompany();
    const product = await createProduct({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: productInput(fixture),
    });

    await createSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: saleInput(product.id, { paymentMode: "UPI" }),
    });

    expect(await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.BANK)).toBe(
      toStorageString(1180),
    );
    expect(await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.CASH)).toBe(
      toStorageString(0),
    );
  });

  it("puts a credit sale into receivables against the customer", async () => {
    const fixture = await createCompany();
    const product = await createProduct({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: productInput(fixture),
    });
    const customer = await createParty({
      companyId: fixture.companyId,
      kind: "CUSTOMER",
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: customerInput(),
    });

    const sale = await createSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: saleInput(product.id, {
        paymentMode: "CREDIT",
        customerId: customer.id,
      }),
    });

    expect(
      await accountBalance(
        fixture.companyId,
        SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
      ),
    ).toBe(toStorageString(1180));

    // Attributed to the customer, so a statement can be produced without
    // parsing narrations.
    const line = await prisma.journalLine.findFirst({
      where: {
        companyId: fixture.companyId,
        partyType: "CUSTOMER",
        partyId: customer.id,
        debit: { gt: 0 },
      },
      select: { debit: true },
    });
    expect(toStorageString(line?.debit ?? 0)).toBe(toStorageString(1180));

    const record = await prisma.sale.findUniqueOrThrow({
      where: { id: sale.id },
      select: { paidAmount: true, dueDate: true },
    });
    expect(toStorageString(record.paidAmount)).toBe(toStorageString(0));
    expect(record.dueDate).not.toBeNull();
  });

  it("refuses a credit sale with nobody to owe it", async () => {
    const fixture = await createCompany();
    const product = await createProduct({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: productInput(fixture),
    });

    // The schema catches this in the action; the service is handed already
    // valid input, so this asserts the rule where users meet it.
    const { saleSchema } = await import("@/lib/validation/sales");
    const parsed = saleSchema.safeParse(
      saleInput(product.id, { paymentMode: "CREDIT" }),
    );
    expect(parsed.success).toBe(false);
  });
});

describe("place of supply", () => {
  it("charges IGST when the customer is in another state", async () => {
    const fixture = await createCompany("29");
    const product = await createProduct({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: productInput(fixture),
    });
    const customer = await createParty({
      companyId: fixture.companyId,
      kind: "CUSTOMER",
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: customerInput({ gstin: "27AABCS1429B1ZX", stateCode: "27" }),
    });

    const sale = await createSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: saleInput(product.id, { customerId: customer.id }),
    });

    expect(sale.supplyType).toBe("INTER_STATE");
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.GST_OUTPUT_IGST),
    ).toBe(toStorageString(-180));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.GST_OUTPUT_CGST),
    ).toBe(toStorageString(0));
    // The customer pays the same either way; only the split differs.
    expect(sale.totalAmount).toBe(toStorageString(1180));
  });
});

describe("stock protection", () => {
  it("refuses to sell stock the business does not have", async () => {
    const fixture = await createCompany();
    const product = await createProduct({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: productInput(fixture, { openingQuantity: 5, openingRate: 60 }),
    });

    await expect(
      createSale({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        branchId: null,
        input: saleInput(product.id, {
          lines: [
            {
              productId: product.id,
              description: "",
              quantity: 8,
              rate: 100,
              discountPercent: 0,
            },
          ],
        }),
      }),
    ).rejects.toThrow(/Only 5 PCS of Widget are in stock/);
  });

  it("leaves nothing behind when a sale is refused", async () => {
    const fixture = await createCompany();
    const product = await createProduct({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: productInput(fixture, { openingQuantity: 5, openingRate: 60 }),
    });

    const entriesBefore = await prisma.journalEntry.count({
      where: { companyId: fixture.companyId },
    });

    await expect(
      createSale({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        branchId: null,
        input: saleInput(product.id, {
          lines: [
            {
              productId: product.id,
              description: "",
              quantity: 8,
              rate: 100,
              discountPercent: 0,
            },
          ],
        }),
      }),
    ).rejects.toThrow(SaleError);

    // The whole thing is one transaction: no invoice, no number burned, no
    // stock movement, no entry.
    expect(
      await prisma.sale.count({ where: { companyId: fixture.companyId } }),
    ).toBe(0);
    expect(
      await prisma.journalEntry.count({
        where: { companyId: fixture.companyId },
      }),
    ).toBe(entriesBefore);
    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { companyId: fixture.companyId, productId: product.id },
      select: { quantity: true },
    });
    expect(toStorageString(balance.quantity)).toBe(toStorageString(5));
  });

  it("sells a service without touching stock", async () => {
    const fixture = await createCompany();
    const service = await createProduct({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: productInput(fixture, {
        sku: "DELIVERY",
        name: "Home delivery",
        isStockTracked: false,
        openingQuantity: 0,
        openingRate: 0,
      }),
    });

    await createSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: saleInput(service.id, {
        lines: [
          {
            productId: service.id,
            description: "",
            quantity: 1,
            rate: 100,
            discountPercent: 0,
          },
        ],
      }),
    });

    expect(
      await prisma.inventoryMovement.count({
        where: { companyId: fixture.companyId, productId: service.id },
      }),
    ).toBe(0);
    // No stock means no cost of sales — the whole ₹100 is margin.
    expect(
      await accountBalance(
        fixture.companyId,
        SYSTEM_ACCOUNT.COST_OF_GOODS_SOLD,
      ),
    ).toBe(toStorageString(0));
    await assertTrialBalances(fixture.companyId);
  });
});

describe("voiding", () => {
  it("cancels the entry, returns the stock and reverses the register", async () => {
    const fixture = await createCompany();
    const product = await createProduct({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: productInput(fixture),
    });

    const sale = await createSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: saleInput(product.id),
    });

    await voidSale({
      companyId: fixture.companyId,
      saleId: sale.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      reason: "Entered twice by mistake",
    });

    // Everything nets back to where it started.
    expect(await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.CASH)).toBe(
      toStorageString(0),
    );
    expect(await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.SALES)).toBe(
      toStorageString(0),
    );
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.GST_OUTPUT_CGST),
    ).toBe(toStorageString(0));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.INVENTORY),
    ).toBe(toStorageString(6000));

    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { companyId: fixture.companyId, productId: product.id },
      select: { quantity: true, averageCost: true },
    });
    expect(toStorageString(balance.quantity)).toBe(toStorageString(100));
    expect(toStorageString(balance.averageCost)).toBe(toStorageString(60));

    const gstNet = await prisma.gstTransaction.aggregate({
      where: { companyId: fixture.companyId, documentId: sale.id },
      _sum: { taxableValue: true, totalTax: true },
    });
    expect(toStorageString(gstNet._sum.taxableValue ?? 0)).toBe(
      toStorageString(0),
    );
    expect(toStorageString(gstNet._sum.totalTax ?? 0)).toBe(toStorageString(0));

    await assertTrialBalances(fixture.companyId);
  });

  it("keeps the original invoice and its entry rather than deleting them", async () => {
    const fixture = await createCompany();
    const product = await createProduct({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: productInput(fixture),
    });
    const sale = await createSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: saleInput(product.id),
    });

    await voidSale({
      companyId: fixture.companyId,
      saleId: sale.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      reason: "Customer changed their mind",
    });

    const record = await prisma.sale.findUniqueOrThrow({
      where: { id: sale.id },
      select: {
        status: true,
        voidReason: true,
        totalAmount: true,
        paidAmount: true,
      },
    });
    expect(record.status).toBe("VOIDED");
    expect(record.voidReason).toBe("Customer changed their mind");
    // The invoice still says what it was for; only its settlement is undone.
    expect(toStorageString(record.totalAmount)).toBe(toStorageString(1180));
    expect(toStorageString(record.paidAmount)).toBe(toStorageString(0));

    const entries = await prisma.journalEntry.findMany({
      where: { companyId: fixture.companyId, sourceId: sale.id },
      select: { status: true, sourceType: true, reversesId: true },
      orderBy: { createdAt: "asc" },
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]?.status).toBe("REVERSED");
    expect(entries[1]?.sourceType).toBe("SALE_VOID");
    // The reversal points back at what it undid.
    expect(entries[1]?.reversesId).not.toBeNull();
  });

  it("refuses to void the same invoice twice", async () => {
    const fixture = await createCompany();
    const product = await createProduct({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: productInput(fixture),
    });
    const sale = await createSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: saleInput(product.id),
    });

    const voidIt = () =>
      voidSale({
        companyId: fixture.companyId,
        saleId: sale.id,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        reason: "Duplicate",
      });

    await voidIt();
    await expect(voidIt()).rejects.toThrow(/already been voided/);
  });
});

describe("tenant isolation", () => {
  it("cannot invoice another company's product", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);
    const theirProduct = await createProduct({
      companyId: theirs.companyId,
      userId: theirs.userId,
      actorEmail: theirs.actorEmail,
      input: productInput(theirs),
    });

    await expect(
      createSale({
        companyId: mine.companyId,
        userId: mine.userId,
        actorEmail: mine.actorEmail,
        branchId: null,
        input: saleInput(theirProduct.id),
      }),
    ).rejects.toThrow(/could not be found/);
  });

  it("cannot void another company's invoice", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);
    const theirProduct = await createProduct({
      companyId: theirs.companyId,
      userId: theirs.userId,
      actorEmail: theirs.actorEmail,
      input: productInput(theirs),
    });
    const theirSale = await createSale({
      companyId: theirs.companyId,
      userId: theirs.userId,
      actorEmail: theirs.actorEmail,
      branchId: null,
      input: saleInput(theirProduct.id),
    });

    await expect(
      voidSale({
        companyId: mine.companyId,
        saleId: theirSale.id,
        userId: mine.userId,
        actorEmail: mine.actorEmail,
        reason: "Not mine to void",
      }),
    ).rejects.toThrow(/could not be found/);

    const untouched = await prisma.sale.findUniqueOrThrow({
      where: { id: theirSale.id },
      select: { status: true },
    });
    expect(untouched.status).toBe("POSTED");
  });
});

describe("numbering", () => {
  it("issues invoice numbers in an unbroken series", async () => {
    const fixture = await createCompany();
    const product = await createProduct({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: productInput(fixture),
    });

    const numbers: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const sale = await createSale({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        branchId: null,
        input: saleInput(product.id, {
          lines: [
            {
              productId: product.id,
              description: "",
              quantity: 1,
              rate: 100,
              discountPercent: 0,
            },
          ],
        }),
      });
      numbers.push(sale.invoiceNumber);
    }

    const series = await invoicePrefix(fixture.companyId);
    expect(numbers).toEqual([
      `${series}0001`,
      `${series}0002`,
      `${series}0003`,
    ]);
  });

  it("does not burn a number on a sale that fails", async () => {
    const fixture = await createCompany();
    const product = await createProduct({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: productInput(fixture, { openingQuantity: 2, openingRate: 60 }),
    });

    await expect(
      createSale({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        branchId: null,
        input: saleInput(product.id, {
          lines: [
            {
              productId: product.id,
              description: "",
              quantity: 5,
              rate: 100,
              discountPercent: 0,
            },
          ],
        }),
      }),
    ).rejects.toThrow(SaleError);

    const sale = await createSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: saleInput(product.id, {
        lines: [
          {
            productId: product.id,
            description: "",
            quantity: 1,
            rate: 100,
            discountPercent: 0,
          },
        ],
      }),
    });

    // A gap in an invoice series is exactly what a tax officer asks about, so
    // the rolled-back attempt must release its number.
    expect(sale.invoiceNumber).toBe(
      `${await invoicePrefix(fixture.companyId)}0001`,
    );
  });
});

describe("audit trail", () => {
  it("records the posting and the void with their entry numbers", async () => {
    const fixture = await createCompany();
    const product = await createProduct({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: productInput(fixture),
    });
    const sale = await createSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: saleInput(product.id),
    });
    await voidSale({
      companyId: fixture.companyId,
      saleId: sale.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      reason: "Wrong customer",
    });

    const log = await prisma.auditLog.findMany({
      where: {
        companyId: fixture.companyId,
        entityType: "Sale",
        entityId: sale.id,
      },
      select: { action: true, metadata: true },
      orderBy: { createdAt: "asc" },
    });

    expect(log.map((entry) => entry.action)).toEqual([
      "sale.posted",
      "sale.voided",
    ]);
    const voidMeta = log[1]?.metadata as Record<string, unknown> | null;
    expect(voidMeta?.reason).toBe("Wrong customer");
    expect(voidMeta?.reversalEntry).toMatch(/^JV-/);
  });
});

/**
 * The credit limit, enforced.
 *
 * It was recorded and read by nothing for as long as it had existed, while the
 * form said "0 means no limit is enforced" — which tells a shopkeeper in as
 * many words that a non-zero one is.
 *
 * What it is tested against is `owedByParty`: the control account's balance for
 * that customer, which is the figure the ageing report, the payment reminder
 * and the customer statement all quote. A refusal measured against a number
 * none of those show is a refusal nobody can argue with — which is why the case
 * below about money paid on account matters as much as the ones about the
 * limit itself.
 */
describe("a customer's credit limit", () => {
  /** A shop, a product at ₹100, and a customer with the limit asked for. */
  async function shopWithLimit(creditLimit: number) {
    const fixture = await createCompany();
    const product = await createProduct({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: productInput(fixture),
    });
    const customer = await createParty({
      companyId: fixture.companyId,
      kind: "CUSTOMER",
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: customerInput({ creditLimit }),
    });
    return { fixture, product, customer };
  }

  /** One credit invoice for `quantity` units at ₹100 plus 18% tax. */
  async function invoice(
    context: Awaited<ReturnType<typeof shopWithLimit>>,
    quantity: number,
  ) {
    return createSale({
      companyId: context.fixture.companyId,
      userId: context.fixture.userId,
      actorEmail: context.fixture.actorEmail,
      branchId: null,
      input: saleInput(context.product.id, {
        paymentMode: "CREDIT",
        customerId: context.customer.id,
        lines: [
          {
            productId: context.product.id,
            description: "",
            quantity,
            rate: 100,
            discountPercent: 0,
          },
        ],
      }),
    });
  }

  it("lets through an invoice that stays inside it", async () => {
    // The control. Without it every case below could pass by refusing
    // everything.
    const shop = await shopWithLimit(5000);
    const sale = await invoice(shop, 10);
    expect(sale.id).toBeTruthy();
  }, 60_000);

  it("refuses the one that would go past it, and says by how much", async () => {
    const shop = await shopWithLimit(5000);
    await invoice(shop, 40); // ₹4,720 with tax.

    // ₹4,720 owed, another ₹1,180 asked for, against ₹5,000.
    await expect(invoice(shop, 10)).rejects.toThrow(
      /owes 4720.00, and this invoice would take them to 5900.00 against a credit limit of 5000.00/,
    );
  }, 60_000);

  it("leaves no gap in the invoice series when it refuses", async () => {
    // The refusal comes after the number is allocated, so that two invoices to
    // one customer serialise on the sequence lock rather than both reading the
    // same balance. A rolled-back insert has to release its number — a missing
    // invoice number is the thing a tax officer asks about.
    const shop = await shopWithLimit(5000);
    await invoice(shop, 40);
    await expect(invoice(shop, 10)).rejects.toThrow();
    const next = await invoice(shop, 1);

    const numbers = await prisma.sale.findMany({
      where: { companyId: shop.fixture.companyId },
      select: { invoiceNumber: true },
      orderBy: { invoiceNumber: "asc" },
    });
    expect(numbers.map((row) => row.invoiceNumber)).toEqual([
      expect.stringMatching(/0001$/),
      expect.stringMatching(/0002$/),
    ]);
    expect(next.id).toBeTruthy();
  }, 60_000);

  it("says nothing about a cash sale", async () => {
    // A limit is what a customer is trusted with. Money taken at the counter
    // is not trust, and blocking it would stop a shop selling to somebody
    // standing in front of it with cash in hand.
    const shop = await shopWithLimit(5000);
    await invoice(shop, 40);

    const cash = await createSale({
      companyId: shop.fixture.companyId,
      userId: shop.fixture.userId,
      actorEmail: shop.fixture.actorEmail,
      branchId: null,
      input: saleInput(shop.product.id, {
        paymentMode: "CASH",
        customerId: shop.customer.id,
        lines: [
          {
            productId: shop.product.id,
            description: "",
            quantity: 50,
            rate: 100,
            discountPercent: 0,
          },
        ],
      }),
    });
    expect(cash.id).toBeTruthy();
  }, 60_000);

  it("counts a limit of nought as no limit", async () => {
    const shop = await shopWithLimit(0);
    const sale = await invoice(shop, 60);
    expect(sale.id).toBeTruthy();
  }, 60_000);

  it("sees money paid on account without being told which invoice", async () => {
    // The case that decides whether this is enforced against the right figure.
    // A receipt with no allocation moves the control account and moves no
    // invoice's `paidAmount`, so per-document arithmetic cannot see it — and a
    // customer who has just paid would be refused for a debt they have settled.
    const shop = await shopWithLimit(5000);
    await invoice(shop, 40); // ₹4,720 owed, ₹280 of room left.

    await createReceipt({
      companyId: shop.fixture.companyId,
      userId: shop.fixture.userId,
      actorEmail: shop.fixture.actorEmail,
      input: {
        kind: "CUSTOMER",
        partyId: shop.customer.id,
        date: new Date().toISOString().slice(0, 10),
        amount: 4000,
        paymentMode: "CASH",
        referenceNo: "",
        notes: "",
        allocations: [],
      },
    });

    // ₹720 owed now. The next ₹1,180 invoice fits where it would not have.
    const sale = await invoice(shop, 10);
    expect(sale.id).toBeTruthy();
  }, 60_000);
});
