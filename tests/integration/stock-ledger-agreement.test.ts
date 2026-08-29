import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegisterInput } from "@/lib/validation/auth";
import type {
  CustomerInput,
  ProductInput,
  SupplierInput,
} from "@/lib/validation/master-data";
import type { PurchaseInput } from "@/lib/validation/purchases";
import type { SaleInput } from "@/lib/validation/sales";
import { registerOwner } from "@/server/auth/registration";
import { reconcileStock } from "@/server/inventory/inventory-report";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createPurchase } from "@/server/purchases/purchase-service";
import { createSale, voidSale } from "@/server/sales/sale-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * The Inventory account and the stock ledger are one figure.
 *
 * `reconcileStock` compares three numbers written by three different parts of
 * the system — the cached position on each product, the sum of its movements,
 * and the Inventory account in the general ledger — and requires them to be
 * identical. No tolerance, and rightly none: a difference means stock moved
 * without the accounting following it, and the auditor raises it at HIGH with
 * the title "Stock on the shelves and stock in the books disagree".
 *
 * Two paths broke it on perfectly ordinary documents, and both broke it the
 * same way: a total cost was divided into a per-unit rate, stored at four
 * decimal places, and multiplied back out — and the round trip does not always
 * land where it started.
 *
 *   • **A bill with a discount.** Three units at ₹33.33 less 10% is ₹89.99
 *     taxable. The Inventory account was debited with that; the stock ledger
 *     recorded 3 × ₹29.9967, which is ₹89.9901. One bill, and the reconciliation
 *     is broken for good — `drifted` is empty, so the report cannot even name a
 *     product, and the recommendation ("open the stock reconciliation, which
 *     shows the two figures side by side") leads to a hundredth of a paisa with
 *     nothing to explain it.
 *
 *   • **Voiding a FIFO invoice.** Three units drawn from a ₹10 layer and a ₹20
 *     one cost ₹40. The sale line stored ₹13.3333 each, so the void put ₹39.9999
 *     back while the reversal credited the ₹40 the sale had charged.
 *
 * `createPurchaseReturn` had the rule written down the whole time — it takes
 * "what the stock ledger actually took out, not what the bill said it cost",
 * because "the Inventory account has to match the stock ledger". These are the
 * two places that did not.
 *
 * The figures below are the smallest ones that break: a shopkeeper who never
 * gives a discount and never voids an invoice would never have seen it, which
 * is why it survived.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

type Method = "FIFO" | "WEIGHTED_AVERAGE";

function registrationInput(email: string, method: Method): RegisterInput {
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
      businessName: "Rounding Test Mart",
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
      inventoryMethod: method,
      loadDemoData: false,
    },
  };
}

type Fixture = {
  companyId: string;
  userId: string;
  actorEmail: string;
  supplierId: string;
  customerId: string;
  productId: string;
};

async function shop(method: Method = "WEIGHTED_AVERAGE"): Promise<Fixture> {
  const email = `round-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const owner = await registerOwner(registrationInput(email, method));
  createdCompanies.push(owner.companyId);

  const taxonomy = await getProductTaxonomy(owner.companyId);
  const unit = taxonomy.units.find((entry) => entry.code === "PCS");
  const gst18 = taxonomy.taxRates.find((entry) => entry.code === "GST18");
  if (!unit || !gst18) throw new Error("Provisioning is incomplete");

  const base = {
    companyId: owner.companyId,
    userId: owner.userId,
    actorEmail: "owner@example.com",
  };

  const [supplier, customer, product] = await Promise.all([
    createParty({
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
    }),
    createParty({
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
        creditLimit: 0,
        openingBalance: 0,
        openingNature: "DEBIT",
        notes: "",
      } satisfies CustomerInput,
    }),
    createProduct({
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
    }),
  ]);

  return {
    ...base,
    supplierId: supplier.id,
    customerId: customer.id,
    productId: product.id,
  };
}

const today = () => new Date().toISOString().slice(0, 10);

function buy(
  fixture: Fixture,
  line: { quantity: number; rate: number; discountPercent?: number },
) {
  return createPurchase({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      supplierId: fixture.supplierId,
      supplierBillNo: "",
      billDate: today(),
      paymentMode: "CREDIT",
      priceIncludesTax: false,
      claimInputCredit: true,
      notes: "",
      lines: [
        {
          productId: fixture.productId,
          description: "",
          quantity: line.quantity,
          rate: line.rate,
          discountPercent: line.discountPercent ?? 0,
        },
      ],
    } satisfies PurchaseInput,
  });
}

function sell(fixture: Fixture, quantity: number) {
  return createSale({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      customerId: fixture.customerId,
      invoiceDate: today(),
      paymentMode: "CASH",
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

/** The reconciliation, and the position behind it. */
async function state(fixture: Fixture) {
  const reconciliation = await reconcileStock(fixture.companyId);
  const balance = await prisma.inventoryBalance.findFirst({
    where: { companyId: fixture.companyId, productId: fixture.productId },
    select: { quantity: true, stockValue: true },
  });
  return {
    reconciliation,
    quantity: balance?.quantity.toString() ?? "0",
    stockValue: balance?.stockValue.toString() ?? "0",
  };
}

beforeAll(async () => {
  await ensurePlatformData();
}, 60_000);

afterAll(async () => {
  for (const id of createdCompanies) {
    await purgeTestCompany(id).catch(() => undefined);
  }
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

describe("what a bill puts into stock", () => {
  it("is what it debits to the Inventory account", async () => {
    const fixture = await shop();

    // ₹99.99 gross, 10% off, ₹89.99 taxable — and 89.99 ÷ 3 does not come back.
    await buy(fixture, { quantity: 3, rate: 33.33, discountPercent: 10 });

    const after = await state(fixture);
    expect(after.reconciliation.accountBalance).toBe("89.9900");
    expect(after.reconciliation.ledgerValue).toBe("89.9900");
    expect(after.reconciliation.movementValue).toBe("89.9900");
    expect(after.reconciliation.accountDifference).toBe("0.0000");
    expect(after.reconciliation.agrees).toBe(true);
  }, 120_000);

  it("leaves nothing behind when the shelf is sold out", async () => {
    const fixture = await shop();

    await buy(fixture, { quantity: 3, rate: 33.33, discountPercent: 10 });
    await sell(fixture, 3);

    const after = await state(fixture);
    // Nothing on the shelf is worth nothing. Three units holding ₹89.99 average
    // ₹29.9967, and charging that rate for all three takes out ₹89.9901 — a
    // hundredth of a paisa the shelf never held, left in the Inventory account
    // on a business that has sold everything it bought.
    expect(after.quantity).toBe("0");
    expect(after.stockValue).toBe("0");
    expect(after.reconciliation.accountBalance).toBe("0.0000");
    expect(after.reconciliation.agrees).toBe(true);
  }, 120_000);
});

describe("a FIFO shelf sold down to nothing", () => {
  it("is worth nothing, whatever the layers make of the units", async () => {
    const fixture = await shop("FIFO");

    await buy(fixture, { quantity: 3, rate: 33.33, discountPercent: 10 });
    await sell(fixture, 3);

    const after = await state(fixture);
    // FIFO cannot reach this on its own. Its layers are rebuilt from the
    // movement ledger and carry a rounded rate, so ₹89.99 across three units
    // becomes a layer of three at ₹29.9967 and costs ₹89.9901 to clear — more
    // than the shelf ever held. The pool is what the books hold and the layers
    // are a reconstruction of it, so the pool is what leaves.
    expect(after.quantity).toBe("0");
    expect(after.stockValue).toBe("0");
    expect(after.reconciliation.accountBalance).toBe("0.0000");
    expect(after.reconciliation.agrees).toBe(true);
  }, 120_000);
});

describe("voiding an invoice under FIFO", () => {
  it("puts back exactly what the sale took out", async () => {
    const fixture = await shop("FIFO");

    await buy(fixture, { quantity: 2, rate: 10 });
    await buy(fixture, { quantity: 2, rate: 20 });

    const before = await state(fixture);
    expect(before.reconciliation.agrees).toBe(true);
    expect(before.reconciliation.accountBalance).toBe("60.0000");

    // Two from the ₹10 layer and one from the ₹20 layer: ₹40, which is ₹13.3333
    // a unit and does not multiply back.
    const sale = await sell(fixture, 3);
    const sold = await state(fixture);
    expect(sold.reconciliation.agrees).toBe(true);
    expect(sold.reconciliation.accountBalance).toBe("20.0000");

    await voidSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      saleId: sale.id,
      reason: "Customer cancelled the order",
    });

    const after = await state(fixture);
    // Back where it started, to the paisa, on both sides.
    expect(after.reconciliation.accountBalance).toBe("60.0000");
    expect(after.reconciliation.ledgerValue).toBe("60.0000");
    expect(after.reconciliation.accountDifference).toBe("0.0000");
    expect(after.reconciliation.agrees).toBe(true);
  }, 120_000);
});
