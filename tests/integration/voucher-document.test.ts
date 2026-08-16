import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegisterInput } from "@/lib/validation/auth";
import type { CustomerInput, ProductInput } from "@/lib/validation/master-data";
import type { SaleInput } from "@/lib/validation/sales";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale } from "@/server/sales/sale-service";
import { createReceipt } from "@/server/settlements/settlement-service";
import { receiptVoucherDocument } from "@/server/documents/voucher-document";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Proof that money changed hands.
 *
 * The figures on a voucher are the ones a shop will have to stand behind if
 * the customer says the payment never happened, so they come from what was
 * posted rather than anything recomputed for the document.
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
      businessName: `Voucher ${uniqueSlug("Mart")}`,
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

type Fixture = {
  companyId: string;
  userId: string;
  customerId: string;
  saleId: string;
  saleTotal: number;
};

async function shopWithAnInvoice(): Promise<Fixture> {
  const email = `voucher-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
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
      sellingPrice: 250,
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
      gstin: "29AABCS1429B1ZX",
      pan: "",
      addressLine1: "",
      city: "",
      stateCode: "29",
      pincode: "",
      creditDays: 30,
      creditLimit: 100_000_000,
      openingBalance: 0,
      openingNature: "DEBIT",
      notes: "",
    } satisfies CustomerInput,
  });

  const sale = await createSale({
    ...base,
    branchId: null,
    input: {
      customerId: customer.id,
      invoiceDate: new Date().toISOString().slice(0, 10),
      paymentMode: "CREDIT",
      placeOfSupply: "",
      priceIncludesTax: false,
      notes: "",
      lines: [
        {
          productId: product.id,
          description: "",
          quantity: 4,
          rate: 250,
          discountPercent: 0,
        },
      ],
    } satisfies SaleInput,
  });

  const posted = await prisma.sale.findUniqueOrThrow({
    where: { id: sale.id },
    select: { totalAmount: true },
  });

  return {
    companyId: result.companyId,
    userId: result.userId,
    customerId: customer.id,
    saleId: sale.id,
    saleTotal: Number(posted.totalAmount),
  };
}

async function settle(fixture: Fixture, amount: number, allocate: number) {
  return createReceipt({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: "owner@example.com",
    input: {
      kind: "CUSTOMER",
      partyId: fixture.customerId,
      date: new Date().toISOString().slice(0, 10),
      paymentMode: "CASH",
      amount,
      referenceNo: "",
      notes: "",
      allocations:
        allocate > 0 ? [{ documentId: fixture.saleId, amount: allocate }] : [],
    },
  });
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

describe("a receipt voucher", () => {
  it("says who paid, how much, and against what", async () => {
    const shop = await shopWithAnInvoice();
    const receipt = await settle(shop, shop.saleTotal, shop.saleTotal);

    const voucher = await receiptVoucherDocument({
      companyId: shop.companyId,
      receiptId: receipt.id,
    });

    expect(voucher?.direction).toBe("RECEIPT");
    expect(voucher?.counterparty?.name).toBe("Sharma Provision Store");
    expect(Number(voucher?.amount)).toBeCloseTo(shop.saleTotal, 2);
    expect(voucher?.against).toHaveLength(1);
    expect(Number(voucher?.against[0]?.allocated)).toBeCloseTo(
      shop.saleTotal,
      2,
    );
  }, 120_000);

  it("names the shop as the party that received it", async () => {
    // The voucher is issued by the shop; a document that did not say by whom
    // would be worth nothing to whoever holds it.
    const shop = await shopWithAnInvoice();
    const receipt = await settle(shop, shop.saleTotal, shop.saleTotal);

    const voucher = await receiptVoucherDocument({
      companyId: shop.companyId,
      receiptId: receipt.id,
    });
    expect(voucher?.issuer.name).toContain("Voucher");
    expect(voucher?.issuer.gstin).toBe("29AAAPR1234K1ZP");
  }, 120_000);

  it("states money paid on account rather than hiding it", async () => {
    // Paying more than the invoice leaves credit standing. A voucher showing
    // only the allocated part would understate what the customer handed over.
    const shop = await shopWithAnInvoice();
    const over = shop.saleTotal + 500;
    const receipt = await settle(shop, over, shop.saleTotal);

    const voucher = await receiptVoucherDocument({
      companyId: shop.companyId,
      receiptId: receipt.id,
    });

    expect(Number(voucher?.amount)).toBeCloseTo(over, 2);
    expect(Number(voucher?.unallocated)).toBeCloseTo(500, 2);
  }, 120_000);

  it("handles a payment made against nothing in particular", async () => {
    const shop = await shopWithAnInvoice();
    const receipt = await settle(shop, 1_000, 0);

    const voucher = await receiptVoucherDocument({
      companyId: shop.companyId,
      receiptId: receipt.id,
    });
    expect(voucher?.against).toEqual([]);
    expect(Number(voucher?.unallocated)).toBeCloseTo(1_000, 2);
  }, 120_000);

  it("takes its figures from what was posted", async () => {
    const shop = await shopWithAnInvoice();
    const receipt = await settle(shop, shop.saleTotal, shop.saleTotal);

    const [voucher, row] = await Promise.all([
      receiptVoucherDocument({
        companyId: shop.companyId,
        receiptId: receipt.id,
      }),
      prisma.receipt.findUniqueOrThrow({
        where: { id: receipt.id },
        select: { amount: true, voucherNumber: true },
      }),
    ]);

    expect(voucher?.voucherNumber).toBe(row.voucherNumber);
    expect(Number(voucher?.amount)).toBeCloseTo(Number(row.amount), 4);
  }, 120_000);
});

describe("one shop's vouchers are its own", () => {
  it("will not read a receipt belonging to another company", async () => {
    // Naming another tenant's receipt id must find nothing rather than print
    // their customer's name and what they paid.
    const [mine, theirs] = await Promise.all([
      shopWithAnInvoice(),
      shopWithAnInvoice(),
    ]);
    const receipt = await settle(theirs, theirs.saleTotal, theirs.saleTotal);

    const crossed = await receiptVoucherDocument({
      companyId: mine.companyId,
      receiptId: receipt.id,
    });
    expect(crossed).toBeNull();
  }, 120_000);
});
