import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StockMovementType } from "@prisma/client";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import {
  branchQuantities,
  recordInward,
  recordOutward,
} from "@/server/inventory/stock-service";
import { createBranch } from "@/server/company/branch-service";
import { postingBranchId } from "@/server/company/posting-branch";
import type { BranchInput } from "@/lib/validation/company";
import { toStorageString } from "@/lib/money";
import type { RegisterInput } from "@/lib/validation/auth";
import type { CustomerInput, ProductInput } from "@/lib/validation/master-data";
import type { StockAdjustmentInput } from "@/lib/validation/inventory";
import type { SaleInput } from "@/lib/validation/sales";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale } from "@/server/sales/sale-service";
import {
  accountBalances,
  accountingEquation,
} from "@/server/accounting/balances";
import {
  createStockAdjustment,
  StockAdjustmentError,
} from "@/server/inventory/adjustment-service";
import {
  getProductStockCard,
  getStockSummary,
  reconcileStock,
  InventoryReportError,
} from "@/server/inventory/inventory-report";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Inventory.
 *
 * Stock is recorded twice by design — as quantities in the inventory ledger and
 * as a rupee balance in the general ledger — by different code down different
 * paths. Most of what follows checks the two still agree after each kind of
 * movement, because a divergence makes every margin figure suspect and nothing
 * else in the product would notice.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];
const TODAY = new Date().toISOString().slice(0, 10);

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
      businessName: "Inventory Test Mart",
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
  unitId: string;
  taxRateId: string;
};

async function createCompany(): Promise<Fixture> {
  const email = `inv-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
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
  const gst0 = taxonomy.taxRates.find((entry) => entry.code === "GST0");
  if (!unit || !gst0) throw new Error("Provisioning is incomplete");

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
      taxRateId: gst0.id,
      purchasePrice: 60,
      sellingPrice: 100,
      mrp: 0,
      isStockTracked: true,
      openingQuantity: 100,
      openingRate: 60,
      minStockLevel: 20,
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

  return {
    ...base,
    productId: product.id,
    customerId: customer.id,
    unitId: unit.id,
    taxRateId: gst0.id,
  };
}

async function sell(fixture: Fixture, quantity: number) {
  return createSale({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      customerId: fixture.customerId,
      invoiceDate: TODAY,
      paymentMode: "CREDIT",
      placeOfSupply: "",
      priceIncludesTax: false,
      notes: "",
      lines: [
        {
          productId: fixture.productId,
          description: "",
          quantity,
          rate: 100,
          discountPercent: 0,
        },
      ],
    } satisfies SaleInput,
  });
}

function adjustment(
  fixture: Fixture,
  overrides: Partial<StockAdjustmentInput> = {},
): StockAdjustmentInput {
  return {
    productId: fixture.productId,
    adjustmentDate: TODAY,
    reason: "COUNT",
    countedQuantity: 100,
    notes: "Counted at the end of the month",
    ...overrides,
  };
}

const adjust = (
  fixture: Fixture,
  overrides: Partial<StockAdjustmentInput> = {},
) =>
  createStockAdjustment({
    companyId: fixture.companyId,
    branchId: null,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    input: adjustment(fixture, overrides),
  });

async function inventoryAccountBalance(companyId: string): Promise<string> {
  const balances = await accountBalances({ companyId });
  const inventory = balances.find(
    (balance) => balance.systemKey === SYSTEM_ACCOUNT.INVENTORY,
  );
  return inventory?.balance.toFixed(4) ?? "0.0000";
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

describe("the stock summary", () => {
  it("shows what is held and what it is worth", async () => {
    const fixture = await createCompany();
    const summary = await getStockSummary({ companyId: fixture.companyId });

    expect(summary.trackedProducts).toBe(1);
    const row = summary.rows[0];
    expect(row?.quantity).toBe(toStorageString(100));
    expect(row?.stockValue).toBe(toStorageString(6000));
    expect(row?.averageCost).toBe(toStorageString(60));
    // What it would fetch, at the price it is listed at.
    expect(row?.sellingValue).toBe(toStorageString(10000));
    expect(summary.totalValue).toBe(toStorageString(6000));
  });

  it("flags what has run low and what has run out", async () => {
    const fixture = await createCompany();
    // 100 on hand, reorder level 20.
    expect(
      (await getStockSummary({ companyId: fixture.companyId })).rows[0]?.status,
    ).toBe("OK");

    await sell(fixture, 85); // 15 left, below the level
    const low = await getStockSummary({ companyId: fixture.companyId });
    expect(low.rows[0]?.status).toBe("LOW");
    expect(low.lowStock).toBe(1);
    expect(low.outOfStock).toBe(0);

    await sell(fixture, 15); // nothing left
    const out = await getStockSummary({ companyId: fixture.companyId });
    expect(out.rows[0]?.status).toBe("OUT");
    expect(out.outOfStock).toBe(1);
  });

  it("does not invent a reorder level for a product without one", async () => {
    const fixture = await createCompany();
    await prisma.product.update({
      where: { id: fixture.productId },
      data: { minStockLevel: 0 },
    });
    await sell(fixture, 99); // one left, and no level to be below

    const summary = await getStockSummary({ companyId: fixture.companyId });
    expect(summary.rows[0]?.status).toBe("OK");
    expect(summary.lowStock).toBe(0);
  });

  it("keeps the headline total across every product when searching", async () => {
    const fixture = await createCompany();
    await createProduct({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        sku: "GADGET",
        name: "Gadget",
        description: "",
        barcode: "",
        hsnCode: "1905",
        categoryId: "",
        unitId: fixture.unitId,
        taxRateId: fixture.taxRateId,
        purchasePrice: 10,
        sellingPrice: 20,
        mrp: 0,
        isStockTracked: true,
        openingQuantity: 50,
        openingRate: 10,
        minStockLevel: 0,
      } satisfies ProductInput,
    });

    const searched = await getStockSummary({
      companyId: fixture.companyId,
      query: "widget",
    });

    expect(searched.rows).toHaveLength(1);
    // ₹6,000 of widgets plus ₹500 of gadgets: the headline does not change
    // because somebody typed in the search box.
    expect(searched.totalValue).toBe(toStorageString(6500));
    expect(searched.trackedProducts).toBe(2);
  });

  it("shows nobody else's stock", async () => {
    const alpha = await createCompany();
    const beta = await createCompany();
    await sell(beta, 10);

    const summary = await getStockSummary({ companyId: alpha.companyId });
    expect(summary.trackedProducts).toBe(1);
    expect(summary.totalValue).toBe(toStorageString(6000));
  });
});

describe("reconciling stock against the books", () => {
  it("agrees on a freshly stocked company", async () => {
    const fixture = await createCompany();
    const check = await reconcileStock(fixture.companyId);

    expect(check.agrees).toBe(true);
    expect(check.ledgerValue).toBe(toStorageString(6000));
    expect(check.movementValue).toBe(toStorageString(6000));
    expect(check.accountBalance).toBe(toStorageString(6000));
    expect(check.drifted).toEqual([]);
  });

  it("still agrees after selling", async () => {
    const fixture = await createCompany();
    await sell(fixture, 30); // ₹1,800 of cost out

    const check = await reconcileStock(fixture.companyId);
    expect(check.agrees).toBe(true);
    expect(check.ledgerValue).toBe(toStorageString(4200));
    expect(check.accountBalance).toBe(toStorageString(4200));
    expect(check.cacheDifference).toBe(toStorageString(0));
    expect(check.accountDifference).toBe(toStorageString(0));
  });

  it("catches a position edited behind the ledger's back", async () => {
    // The reconciliation exists for exactly this: a cached figure changed
    // without the movement that would explain it.
    const fixture = await createCompany();
    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { companyId: fixture.companyId, productId: fixture.productId },
      select: { id: true },
    });
    await prisma.inventoryBalance.update({
      where: { id: balance.id },
      data: { stockValue: "9999.0000" },
    });

    const check = await reconcileStock(fixture.companyId);
    expect(check.agrees).toBe(false);
    expect(check.cacheDifference).toBe(toStorageString(3999));
    expect(check.drifted).toHaveLength(1);
    expect(check.drifted[0]?.sku).toBe("WIDGET");
    expect(check.drifted[0]?.cached).toBe(toStorageString(9999));
    expect(check.drifted[0]?.fromMovements).toBe(toStorageString(6000));
  });

  it("does not repair what it finds", async () => {
    const fixture = await createCompany();
    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { companyId: fixture.companyId, productId: fixture.productId },
      select: { id: true },
    });
    await prisma.inventoryBalance.update({
      where: { id: balance.id },
      data: { stockValue: "1.0000" },
    });

    await reconcileStock(fixture.companyId);
    // Silently correcting it would destroy the evidence of how it broke.
    const after = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { id: balance.id },
      select: { stockValue: true },
    });
    expect(toStorageString(after.stockValue)).toBe(toStorageString(1));
  });

  it("reconciles each company separately", async () => {
    const alpha = await createCompany();
    const beta = await createCompany();
    await sell(beta, 50);

    expect((await reconcileStock(alpha.companyId)).ledgerValue).toBe(
      toStorageString(6000),
    );
    expect((await reconcileStock(beta.companyId)).ledgerValue).toBe(
      toStorageString(3000),
    );
  });
});

describe("adjusting stock", () => {
  it("writes off damaged goods as a cost, and moves the stock", async () => {
    const fixture = await createCompany();

    const result = await adjust(fixture, {
      reason: "DAMAGE",
      countedQuantity: 90,
      notes: "A carton was crushed in the storeroom",
    });

    expect(result.direction).toBe("out");
    expect(result.quantity).toBe(toStorageString(10));
    expect(result.value).toBe(toStorageString(600));
    expect(result.quantityAfter).toBe(toStorageString(90));

    // Stock is down and the loss is a cost, not a disappearance.
    expect(await inventoryAccountBalance(fixture.companyId)).toBe("5400.0000");
    const balances = await accountBalances({ companyId: fixture.companyId });
    expect(
      balances
        .find((entry) => entry.systemKey === SYSTEM_ACCOUNT.DIRECT_EXPENSES)
        ?.balance.toFixed(2),
    ).toBe("600.00");
    expect(accountingEquation(balances).balanced).toBe(true);
    expect((await reconcileStock(fixture.companyId)).agrees).toBe(true);
  });

  it("treats stock found as a correction, never as income", async () => {
    const fixture = await createCompany();

    const result = await adjust(fixture, {
      reason: "FOUND",
      countedQuantity: 105,
      notes: "A box behind the shelf that was never booked in",
    });

    expect(result.direction).toBe("in");
    expect(result.value).toBe(toStorageString(300)); // 5 at the ₹60 average

    const balances = await accountBalances({ companyId: fixture.companyId });
    expect(await inventoryAccountBalance(fixture.companyId)).toBe("6300.0000");
    // It reverses the loss account rather than being credited to revenue —
    // turnover inflated with goods nobody bought is a GST problem.
    expect(
      balances
        .find((entry) => entry.systemKey === SYSTEM_ACCOUNT.DIRECT_EXPENSES)
        ?.balance.toFixed(2),
    ).toBe("-300.00");
    expect(
      balances
        .find((entry) => entry.systemKey === SYSTEM_ACCOUNT.SALES)
        ?.balance.toFixed(2),
    ).toBe("0.00");
    expect(accountingEquation(balances).balanced).toBe(true);
  });

  it("values found stock at what the rest of it is worth", async () => {
    const fixture = await createCompany();
    const result = await adjust(fixture, {
      reason: "COUNT",
      countedQuantity: 110,
      notes: "Count came out higher than the books",
    });

    // Ten more at the ₹60 average, not at a price somebody guessed.
    expect(result.value).toBe(toStorageString(600));
    const summary = await getStockSummary({ companyId: fixture.companyId });
    expect(summary.rows[0]?.averageCost).toBe(toStorageString(60));
  });

  it("refuses a write-off reason that would increase stock", async () => {
    const fixture = await createCompany();

    await expect(
      adjust(fixture, {
        reason: "THEFT",
        countedQuantity: 120,
        notes: "This makes no sense",
      }),
    ).rejects.toThrow(/can only reduce stock/i);
  });

  it("refuses an adjustment that changes nothing", async () => {
    const fixture = await createCompany();

    await expect(
      adjust(fixture, { countedQuantity: 100, notes: "Same as the books" }),
    ).rejects.toThrow(/nothing to correct/i);
  });

  it("refuses to adjust a product that is not stock tracked", async () => {
    const fixture = await createCompany();
    await prisma.product.update({
      where: { id: fixture.productId },
      data: { isStockTracked: false },
    });

    await expect(adjust(fixture, { countedQuantity: 5 })).rejects.toThrow(
      /not stock tracked/i,
    );
  });

  it("will not adjust another company's product", async () => {
    const alpha = await createCompany();
    const beta = await createCompany();

    await expect(
      createStockAdjustment({
        companyId: alpha.companyId,
        branchId: null,
        userId: alpha.userId,
        actorEmail: alpha.actorEmail,
        input: adjustment(beta, { countedQuantity: 1 }),
      }),
    ).rejects.toThrow(StockAdjustmentError);
  });

  it("records who did it and what they said", async () => {
    const fixture = await createCompany();
    await adjust(fixture, {
      reason: "EXPIRY",
      countedQuantity: 95,
      notes: "Five packets past their date, taken off the shelf",
    });

    const log = await prisma.auditLog.findFirst({
      where: { companyId: fixture.companyId, action: "stock.adjusted" },
      select: { metadata: true },
    });
    const metadata = log?.metadata as Record<string, unknown> | null;

    expect(metadata?.reason).toBe("EXPIRY");
    expect(metadata?.booksQuantity).toBe(toStorageString(100));
    expect(metadata?.countedQuantity).toBe(toStorageString(95));
    expect(metadata?.notes).toMatch(/past their date/);
  });

  it("keeps stock and the books in step across a run of movements", async () => {
    const fixture = await createCompany();
    await sell(fixture, 20);
    await adjust(fixture, {
      reason: "DAMAGE",
      countedQuantity: 75,
      notes: "Two broken",
    });
    await sell(fixture, 25);
    await adjust(fixture, {
      reason: "FOUND",
      countedQuantity: 55,
      notes: "Found a box",
    });

    const check = await reconcileStock(fixture.companyId);
    expect(check.agrees).toBe(true);
    expect(check.drifted).toEqual([]);

    const summary = await getStockSummary({ companyId: fixture.companyId });
    expect(summary.rows[0]?.quantity).toBe(toStorageString(55));
    expect(check.accountBalance).toBe(summary.totalValue);
    expect(
      accountingEquation(
        await accountBalances({ companyId: fixture.companyId }),
      ).balanced,
    ).toBe(true);
  });
});

describe("a product's stock card", () => {
  it("lists every movement with the balance after it", async () => {
    const fixture = await createCompany();
    await sell(fixture, 10);
    await adjust(fixture, {
      reason: "DAMAGE",
      countedQuantity: 85,
      notes: "Crushed",
    });

    const card = await getProductStockCard({
      companyId: fixture.companyId,
      productId: fixture.productId,
    });

    expect(card.product.sku).toBe("WIDGET");
    expect(card.quantity).toBe(toStorageString(85));
    // Newest first: opening, then the sale, then the write-off.
    expect(card.movements).toHaveLength(3);
    expect(card.movements[0]?.type).toBe("WRITE_OFF");
    expect(card.movements[0]?.quantity).toBe(toStorageString(-5));
    expect(card.movements[0]?.balanceQuantity).toBe(toStorageString(85));
    expect(card.movements.at(-1)?.type).toBe("OPENING");
  });

  it("names each movement in words and links to the document behind it", async () => {
    const fixture = await createCompany();
    const sale = await sell(fixture, 10);

    const card = await getProductStockCard({
      companyId: fixture.companyId,
      productId: fixture.productId,
    });
    const sold = card.movements.find((movement) => movement.type === "SALE");

    expect(sold?.typeLabel).toBe("Sold");
    expect(sold?.documentHref).toBe(`/app/sales/${sale.id}`);
    expect(
      card.movements.find((movement) => movement.type === "OPENING")?.typeLabel,
    ).toBe("Opening stock");
  });

  it("will not open another company's product", async () => {
    const alpha = await createCompany();
    const beta = await createCompany();

    await expect(
      getProductStockCard({
        companyId: alpha.companyId,
        productId: beta.productId,
      }),
    ).rejects.toThrow(InventoryReportError);
  });
});

/**
 * Discontinuing a line the shop still owns stock of.
 *
 * Archiving a product takes it out of the stock list, which is what archiving
 * is for. It was taking the product's *stock value* out with it, and that value
 * stays in the Inventory account — so the stock report and the balance sheet
 * came apart by exactly the amount of whatever was archived, silently.
 *
 * What makes this one worth a test rather than a note is that the check written
 * to catch it could not. `reconcileStock` reads every balance, archived or not,
 * so it went on reporting that the stock ledger and the books agreed while the
 * report a shopkeeper actually reads had lost six thousand rupees. The two did
 * not mean the same thing by "every product", and only one of them said so.
 */
describe("a discontinued product that still holds stock", () => {
  async function archive(fixture: Fixture) {
    const { setProductArchived } =
      await import("@/server/master-data/product-service");
    await setProductArchived({
      companyId: fixture.companyId,
      productId: fixture.productId,
      archived: true,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
    });
  }

  it("keeps its value in the stock report, so the books still agree", async () => {
    const fixture = await createCompany();

    const before = await getStockSummary({ companyId: fixture.companyId });
    expect(Number(before.totalValue)).toBeGreaterThan(0);

    await archive(fixture);

    const after = await getStockSummary({ companyId: fixture.companyId });
    const ledger = await inventoryAccountBalance(fixture.companyId);

    // Asserted against the Inventory account rather than a literal: the point
    // is that the two agree, not that either is a particular number.
    expect(Number(after.totalValue)).toBeCloseTo(Number(ledger), 2);
    expect(Number(after.totalValue)).toBeCloseTo(Number(before.totalValue), 2);
  }, 90_000);

  it("says on the row that it is discontinued", async () => {
    // Otherwise a line somebody archived reappears with no explanation, which
    // reads as the archive not having worked.
    const fixture = await createCompany();
    await archive(fixture);

    const summary = await getStockSummary({ companyId: fixture.companyId });
    const row = summary.rows.find(
      (entry) => entry.productId === fixture.productId,
    );
    expect(row).toBeDefined();
    expect(row!.archived).toBe(true);
  }, 90_000);

  it("drops out once the stock is gone", async () => {
    // Archiving still does what archiving is for. It is the stock that keeps
    // the row alive, not the product.
    const fixture = await createCompany();
    const summary = await getStockSummary({ companyId: fixture.companyId });
    const held = Number(
      summary.rows.find((entry) => entry.productId === fixture.productId)!
        .quantity,
    );

    // Write the whole position off, then discontinue it.
    await adjust(fixture, { countedQuantity: 0 });
    await archive(fixture);

    const after = await getStockSummary({ companyId: fixture.companyId });
    expect(
      after.rows.find((entry) => entry.productId === fixture.productId),
    ).toBeUndefined();
    expect(held).toBeGreaterThan(0);

    const ledger = await inventoryAccountBalance(fixture.companyId);
    expect(Number(after.totalValue)).toBeCloseTo(Number(ledger), 2);
  }, 90_000);

  it("leaves an ordinary product marked as not discontinued", async () => {
    const fixture = await createCompany();
    const summary = await getStockSummary({ companyId: fixture.companyId });
    const row = summary.rows.find(
      (entry) => entry.productId === fixture.productId,
    );
    expect(row!.archived).toBe(false);
  }, 90_000);
});

/**
 * Switching a product to a non-stock item.
 *
 * The refusal was already here and its reason was already right: turning
 * tracking off on a product that holds stock strands that stock's value in the
 * Inventory account, because the stock report drops an untracked product and
 * the balance sheet does not.
 *
 * It asked `openingQuantity` — the number typed when the product was first set
 * up, which never moves again — instead of what the product holds. So a line
 * opened at nil and stocked by purchases afterwards, which is most of them,
 * walked straight through with a full shelf; and a line opened at a hundred and
 * since sold down to nothing was refused a change that was perfectly safe. The
 * rule was right and it was reading the wrong number, which is the kind of
 * mistake a guard cannot report about itself.
 */
describe("turning stock tracking off", () => {
  const productShape = (fixture: Fixture, sku: string) => ({
    sku,
    name: sku,
    description: "",
    barcode: "",
    hsnCode: "1905",
    categoryId: "",
    unitId: fixture.unitId,
    taxRateId: fixture.taxRateId,
    purchasePrice: 60,
    sellingPrice: 100,
    mrp: 0,
    openingQuantity: 0,
    openingRate: 0,
    minStockLevel: 0,
  });

  async function untrack(fixture: Fixture, productId: string, sku: string) {
    const { updateProduct } =
      await import("@/server/master-data/product-service");
    return updateProduct({
      companyId: fixture.companyId,
      productId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        ...productShape(fixture, sku),
        isStockTracked: false,
      } satisfies ProductInput,
    });
  }

  it("is refused on stock that arrived after the product was created", async () => {
    // The dangerous direction: nil opening quantity, a shelf full of goods.
    const fixture = await createCompany();
    const { createProduct: mkProduct } =
      await import("@/server/master-data/product-service");

    const later = await mkProduct({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        ...productShape(fixture, "LATER"),
        isStockTracked: true,
      } satisfies ProductInput,
    });
    await adjust(fixture, { productId: later.id, countedQuantity: 40 });

    await expect(untrack(fixture, later.id, "LATER")).rejects.toMatchObject({
      code: "HAS_STOCK",
    });

    // And the report still ties to the books, which is what the refusal is for.
    const summary = await getStockSummary({ companyId: fixture.companyId });
    const ledger = await inventoryAccountBalance(fixture.companyId);
    expect(Number(summary.totalValue)).toBeCloseTo(Number(ledger), 2);
  }, 90_000);

  it("is allowed once the stock has gone, whatever it opened with", async () => {
    // The other direction: the fixture product opened at a hundred. Sold down
    // to nothing it holds nothing, and the change is safe.
    const fixture = await createCompany();
    await adjust(fixture, { countedQuantity: 0 });

    await expect(
      untrack(fixture, fixture.productId, "WIDGET"),
    ).resolves.toBeUndefined();
  }, 90_000);

  it("says how much is still held, so the refusal can be acted on", async () => {
    const fixture = await createCompany();
    await adjust(fixture, { countedQuantity: 7 });

    await expect(untrack(fixture, fixture.productId, "WIDGET")).rejects.toThrow(
      /still holds 7 /,
    );
  }, 90_000);

  it("leaves a tracked product tracked when nothing asked otherwise", async () => {
    const fixture = await createCompany();
    const { updateProduct } =
      await import("@/server/master-data/product-service");
    await updateProduct({
      companyId: fixture.companyId,
      productId: fixture.productId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        ...productShape(fixture, "WIDGET"),
        sellingPrice: 120,
        isStockTracked: true,
      } satisfies ProductInput,
    });

    const summary = await getStockSummary({ companyId: fixture.companyId });
    const ledger = await inventoryAccountBalance(fixture.companyId);
    expect(Number(summary.totalValue)).toBeCloseTo(Number(ledger), 2);
    expect(Number(summary.totalValue)).toBeGreaterThan(0);
  }, 90_000);
});

/**
 * Two things happening to one product at the same time.
 *
 * A position is held twice by design — as a cached balance on the product and
 * as the append-only movement ledger it is built from — and `reconcileStock`
 * exists to notice when the two stop agreeing. This is how they stopped.
 *
 * Recording a movement reads the balance, works out the new one in JavaScript
 * and writes it back. Under the default isolation a second transaction reads
 * the same starting figure before the first has committed, so it computes its
 * own answer from a number that is already stale and overwrites it. The
 * movement rows are inserts and all of them survive; only the cached balance
 * loses them, so the ledger is right and the position is wrong.
 *
 * Two *sales* cannot do this to each other, which is worth saying because it
 * is the obvious guess: every sale allocates an invoice number, that takes a
 * row lock on the company's sale sequence, and the second sale waits there
 * until the first has finished. It is the paths that do not share a sequence
 * that race — a sale against a delivery being booked in, either against a
 * stock adjustment, which takes no document number at all.
 *
 * The lock is taken per company rather than per product. It sits between the
 * document number and the journal number, which is where every path already
 * touches stock, so the order is the same everywhere and nothing can deadlock
 * against anything else. Per product would be finer and would need every
 * caller to take its lines in a fixed order to stay safe; a shop posts a
 * handful of stock movements a minute, and serialising those is not a cost it
 * can measure.
 */
describe("two movements at once", () => {
  it("keeps the cached position and the ledger in step", async () => {
    const fixture = await createCompany();
    const branch = await prisma.branch.findFirstOrThrow({
      where: { companyId: fixture.companyId },
      select: { id: true },
    });

    const take = () =>
      prisma.$transaction(
        (tx) =>
          recordOutward(tx, {
            companyId: fixture.companyId,
            productId: fixture.productId,
            branchId: branch.id,
            method: "WEIGHTED_AVERAGE",
            quantity: 1,
            movementType: StockMovementType.SALE,
            movementDate: new Date(),
            sourceType: "CONCURRENCY_TEST",
            sourceId: fixture.productId,
          }),
        { timeout: 30_000 },
      );

    // Eight at once. One or two survived before the lock; the rest were
    // computed from a stale figure and written over each other.
    await Promise.all(Array.from({ length: 8 }, take));

    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { companyId: fixture.companyId, productId: fixture.productId },
      select: { quantity: true },
    });
    const ledger = await prisma.inventoryMovement.aggregate({
      where: { companyId: fixture.companyId, productId: fixture.productId },
      _sum: { quantity: true },
    });

    // Opened at 100, eight taken out.
    expect(Number(balance.quantity)).toBe(92);
    expect(Number(ledger._sum.quantity)).toBe(92);
  }, 200_000);

  it("leaves nothing for the reconciliation to find", async () => {
    // Said through the check that exists for this, because a drift the
    // reconciliation cannot see is worse than one it reports.
    const fixture = await createCompany();
    const branch = await prisma.branch.findFirstOrThrow({
      where: { companyId: fixture.companyId },
      select: { id: true },
    });

    await Promise.all(
      Array.from({ length: 6 }, () =>
        prisma.$transaction(
          (tx) =>
            recordOutward(tx, {
              companyId: fixture.companyId,
              productId: fixture.productId,
              branchId: branch.id,
              method: "WEIGHTED_AVERAGE",
              quantity: 2,
              movementType: StockMovementType.SALE,
              movementDate: new Date(),
              sourceType: "CONCURRENCY_TEST",
              sourceId: fixture.productId,
            }),
          { timeout: 30_000 },
        ),
      ),
    );

    const check = await reconcileStock(fixture.companyId);
    expect(check.cacheDifference).toBe(toStorageString(0));
    expect(check.drifted).toEqual([]);
  }, 200_000);

  it("holds when stock is going out and coming in at once", async () => {
    // The realistic shape of it, and the one the outward-only cases miss: a
    // sale at the counter while a delivery is being booked in. Both directions
    // read the same position and write it back, so both have to wait on the
    // same lock or the pair drift against each other.
    const fixture = await createCompany();
    const branch = await prisma.branch.findFirstOrThrow({
      where: { companyId: fixture.companyId },
      select: { id: true },
    });
    const shared = {
      companyId: fixture.companyId,
      productId: fixture.productId,
      branchId: branch.id,
      method: "WEIGHTED_AVERAGE" as const,
      movementDate: new Date(),
      sourceType: "CONCURRENCY_TEST",
      sourceId: fixture.productId,
    };

    await Promise.all([
      ...Array.from({ length: 4 }, () =>
        prisma.$transaction(
          (tx) =>
            recordOutward(tx, {
              ...shared,
              quantity: 1,
              movementType: StockMovementType.SALE,
            }),
          { timeout: 30_000 },
        ),
      ),
      ...Array.from({ length: 4 }, () =>
        prisma.$transaction(
          (tx) =>
            recordInward(tx, {
              ...shared,
              quantity: 1,
              cost: 60,
              movementType: StockMovementType.PURCHASE,
            }),
          { timeout: 30_000 },
        ),
      ),
    ]);

    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { companyId: fixture.companyId, productId: fixture.productId },
      select: { quantity: true },
    });
    const ledger = await prisma.inventoryMovement.aggregate({
      where: { companyId: fixture.companyId, productId: fixture.productId },
      _sum: { quantity: true },
    });

    // Four out and four in against an opening hundred leaves it where it was.
    expect(Number(balance.quantity)).toBe(100);
    expect(Number(ledger._sum.quantity)).toBe(100);

    const check = await reconcileStock(fixture.companyId);
    expect(check.cacheDifference).toBe(toStorageString(0));
  }, 200_000);
});

/**
 * Which branch's stock a FIFO sale is allowed to reach.
 *
 * A position is kept per branch: the cached balance is looked up on
 * `branchId` exactly, opening stock is placed on the primary branch, and every
 * movement is written with the branch it happened at. Null is its own bucket —
 * a member invited without a branch creates documents that sit there.
 *
 * The FIFO layers were rebuilt from a query that filtered on the branch only
 * when one was given, so a null branch matched every movement in the company.
 * One function then answered "what is here" two different ways: the balance
 * from this branch, the layers from all of them.
 *
 * That is not a reporting nicety. `recordOutward` promises to refuse to go
 * negative — stock the business does not have cannot have a cost, and posting
 * one puts a fabricated cost of goods sold in the accounts and a negative asset
 * on the balance sheet. Under FIFO the guard read the pooled quantity, so it
 * let the sale through, took the cost from another branch's layers, and wrote
 * the shortfall onto a branch that never had the goods.
 *
 * Under weighted average the same sale is refused, because that path reads the
 * balance. Two methods disagreeing about whether a sale is possible at all is
 * how somebody discovers this in their year-end accounts.
 */
describe("stock at one branch and a sale at another", () => {
  async function shopWithStockAtTheBranchOnly(): Promise<{
    fixture: Fixture;
    branchId: string;
  }> {
    const fixture = await createCompany();
    const branch = await prisma.branch.findFirstOrThrow({
      where: { companyId: fixture.companyId },
      select: { id: true },
    });
    // Opening stock always lands on the primary branch, so head office — the
    // null bucket — holds nothing at all.
    return { fixture, branchId: branch.id };
  }

  it("refuses a FIFO sale from a branch that holds none of it", async () => {
    const { fixture } = await shopWithStockAtTheBranchOnly();

    await expect(
      prisma.$transaction((tx) =>
        recordOutward(tx, {
          companyId: fixture.companyId,
          productId: fixture.productId,
          branchId: null,
          method: "FIFO",
          quantity: 5,
          movementType: StockMovementType.SALE,
          movementDate: new Date(),
          sourceType: "BRANCH_SCOPE_TEST",
          sourceId: fixture.productId,
        }),
      ),
    ).rejects.toThrow(/in stock/i);
  }, 90_000);

  it("does not leave a branch holding negative stock", async () => {
    // The consequence, said in the books rather than in an exception: the
    // sale that should not have happened wrote its shortfall somewhere.
    const { fixture } = await shopWithStockAtTheBranchOnly();

    await prisma
      .$transaction((tx) =>
        recordOutward(tx, {
          companyId: fixture.companyId,
          productId: fixture.productId,
          branchId: null,
          method: "FIFO",
          quantity: 5,
          movementType: StockMovementType.SALE,
          movementDate: new Date(),
          sourceType: "BRANCH_SCOPE_TEST",
          sourceId: fixture.productId,
        }),
      )
      .catch(() => undefined);

    const balances = await prisma.inventoryBalance.findMany({
      where: { companyId: fixture.companyId, productId: fixture.productId },
      select: { branchId: true, quantity: true },
    });
    for (const balance of balances) {
      expect(Number(balance.quantity)).toBeGreaterThanOrEqual(0);
    }
  }, 90_000);

  it("agrees with weighted average about whether the sale is possible", async () => {
    // The same call on the same stock, one method each. Whether a shop can
    // sell what it does not have is not a question its valuation method gets
    // to answer differently.
    const { fixture } = await shopWithStockAtTheBranchOnly();

    const attempt = (method: "FIFO" | "WEIGHTED_AVERAGE") =>
      prisma
        .$transaction((tx) =>
          recordOutward(tx, {
            companyId: fixture.companyId,
            productId: fixture.productId,
            branchId: null,
            method,
            quantity: 5,
            movementType: StockMovementType.SALE,
            movementDate: new Date(),
            sourceType: "BRANCH_SCOPE_TEST",
            sourceId: fixture.productId,
          }),
        )
        .then(() => "allowed" as const)
        .catch(() => "refused" as const);

    expect(await attempt("WEIGHTED_AVERAGE")).toBe("refused");
    expect(await attempt("FIFO")).toBe("refused");
  }, 90_000);

  it("still sells from the branch that does hold the stock", async () => {
    // The fix must not scope the layers so tightly that an ordinary sale at
    // the branch stops finding its own goods.
    const { fixture, branchId } = await shopWithStockAtTheBranchOnly();

    const result = await prisma.$transaction((tx) =>
      recordOutward(tx, {
        companyId: fixture.companyId,
        productId: fixture.productId,
        branchId,
        method: "FIFO",
        quantity: 5,
        movementType: StockMovementType.SALE,
        movementDate: new Date(),
        sourceType: "BRANCH_SCOPE_TEST",
        sourceId: fixture.productId,
      }),
    );

    expect(Number(result.quantityAfter)).toBe(95);
    expect(Number(result.unitCost)).toBeGreaterThan(0);
  }, 90_000);
});

/**
 * Stock at a branch, and the figure the form shows for it.
 *
 * Stock is held per branch. A sale takes it out of the branch it posts to and
 * `recordOutward` refuses to go below nil *there* — so "what is in stock",
 * asked by the invoice form, and "what is in stock", answered by the sale, are
 * one question with one answer.
 *
 * The form was adding every branch's balance together. A cashier at the second
 * shop saw the first shop's stock in the badge beside the product, saw no
 * shortage warning under a quantity their own shelf could not cover, and was
 * refused on submit with a different number in the message. The stock
 * adjustment form had been given the rule already, in as many words: "the same
 * branch the adjustment will post against, so the figure shown beside the count
 * box is the one it will be compared with." The sales form had not.
 *
 * `postingBranchId` is now the one place that decides which branch a member's
 * document lands on, and `branchQuantities` the one place that reads a shelf.
 * The cases below hold the two together.
 */
describe("stock at a branch", () => {
  async function twoBranchShop() {
    const fixture = await createCompany();
    const primary = await prisma.branch.findFirstOrThrow({
      where: { companyId: fixture.companyId, isPrimary: true },
      select: { id: true },
    });
    const second = await createBranch({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        code: "BR2",
        name: "Jayanagar",
        addressLine1: "",
        city: "Bengaluru",
        stateCode: "29",
        pincode: "",
        phone: "",
      } satisfies BranchInput,
    });

    return { fixture, primaryId: primary.id, secondId: second.id };
  }

  it("is held on the branch it arrived at, and nowhere else", async () => {
    const { fixture, primaryId, secondId } = await twoBranchShop();

    const atPrimary = await branchQuantities(prisma, {
      companyId: fixture.companyId,
      branchId: primaryId,
      productIds: [fixture.productId],
    });
    const atSecond = await branchQuantities(prisma, {
      companyId: fixture.companyId,
      branchId: secondId,
      productIds: [fixture.productId],
    });

    // Opening stock was placed on the primary branch. The second shop has an
    // empty shelf, and an absent row is what an empty shelf looks like.
    expect(Number(atPrimary.get(fixture.productId))).toBe(100);
    expect(atSecond.get(fixture.productId)).toBeUndefined();
  });

  it("reads the same figure the sale will be refused against", async () => {
    const { fixture, secondId } = await twoBranchShop();

    // What the invoice form would put in the badge for a cashier at the second
    // shop, and what it would compare the line quantity with.
    const available = await branchQuantities(prisma, {
      companyId: fixture.companyId,
      branchId: secondId,
      productIds: [fixture.productId],
    });
    const shown = Number(available.get(fixture.productId) ?? 0);

    await expect(
      createSale({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        branchId: secondId,
        input: {
          customerId: fixture.customerId,
          invoiceDate: TODAY,
          paymentMode: "CREDIT",
          placeOfSupply: "",
          priceIncludesTax: false,
          notes: "",
          lines: [
            {
              productId: fixture.productId,
              description: "",
              quantity: 20,
              rate: 100,
              discountPercent: 0,
            },
          ],
        } satisfies SaleInput,
      }),
    ).rejects.toThrow(/Only 0 .* in stock/);

    // The point of the case: the form's number and the refusal's number are the
    // same number. Read from the whole business it was 100, and the cashier was
    // shown no warning at all before being refused.
    expect(shown).toBe(0);
  });

  it("sells what the branch actually holds", async () => {
    // The other half, so the case above cannot pass by refusing everything.
    const { fixture, primaryId } = await twoBranchShop();

    const available = await branchQuantities(prisma, {
      companyId: fixture.companyId,
      branchId: primaryId,
      productIds: [fixture.productId],
    });
    expect(Number(available.get(fixture.productId))).toBe(100);

    const sale = await createSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: primaryId,
      input: {
        customerId: fixture.customerId,
        invoiceDate: TODAY,
        paymentMode: "CREDIT",
        placeOfSupply: "",
        priceIncludesTax: false,
        notes: "",
        lines: [
          {
            productId: fixture.productId,
            description: "",
            quantity: 20,
            rate: 100,
            discountPercent: 0,
          },
        ],
      } satisfies SaleInput,
    });
    expect(sale.id).toBeTruthy();

    const after = await branchQuantities(prisma, {
      companyId: fixture.companyId,
      branchId: primaryId,
      productIds: [fixture.productId],
    });
    expect(Number(after.get(fixture.productId))).toBe(80);
  });

  it("shows nobody else's shelf", async () => {
    const mine = await createCompany();
    const theirs = await createCompany();
    const theirPrimary = await prisma.branch.findFirstOrThrow({
      where: { companyId: theirs.companyId, isPrimary: true },
      select: { id: true },
    });

    // Another tenant's branch id with this tenant's company id resolves to
    // nothing rather than to their stock.
    const quantities = await branchQuantities(prisma, {
      companyId: mine.companyId,
      branchId: theirPrimary.id,
      productIds: [theirs.productId, mine.productId],
    });

    expect(quantities.size).toBe(0);
  });
});

describe("the branch a member's document posts to", () => {
  it("is the member's own branch where they have one", async () => {
    const fixture = await createCompany();
    const second = await createBranch({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        code: "BR3",
        name: "Malleswaram",
        addressLine1: "",
        city: "Bengaluru",
        stateCode: "29",
        pincode: "",
        phone: "",
      } satisfies BranchInput,
    });

    await expect(
      postingBranchId(prisma, {
        companyId: fixture.companyId,
        memberBranchId: second.id,
      }),
    ).resolves.toBe(second.id);
  });

  it("is the primary branch for a member restricted to none", async () => {
    const fixture = await createCompany();
    const primary = await prisma.branch.findFirstOrThrow({
      where: { companyId: fixture.companyId, isPrimary: true },
      select: { id: true },
    });

    await expect(
      postingBranchId(prisma, {
        companyId: fixture.companyId,
        memberBranchId: null,
      }),
    ).resolves.toBe(primary.id);
  });
});
